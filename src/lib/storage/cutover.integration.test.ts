import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// storage:cutover against real Postgres: a database with collections whose
// rows are still in the old shared `records` table is copied into
// per-collection tables (ids, timestamps, status, soft deletes kept; the
// sequence moved past the copied ids; count and md5 verified), inference
// runs, a re-run is a no-op, a dry run and a failed copy leave nothing
// behind, and `records` is dropped only when every collection still matches
// what was copied.
//
// `records` is no longer in the Drizzle schema or created by any code path,
// so this file recreates the legacy table itself.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "cutover-user";
const ORG_ID = "cutover-org";

type Cutover = typeof import("./cutover");
type RecordsService = typeof import("@/lib/services/records");

function ok<T>(result: T): Exclude<T, { error: unknown } | null | undefined> {
  if (result == null || (typeof result === "object" && "error" in (result as object))) {
    throw new Error(`Expected success result, got: ${JSON.stringify(result)}`);
  }
  return result as Exclude<T, { error: unknown } | null | undefined>;
}

describe.skipIf(!TEST_DB_URL)("storage cutover against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let cutover: Cutover;
  let recordsSvc: RecordsService;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    process.env.HUTCH_PROJECT_THRESHOLD = "5";
    process.env.HUTCH_UNWIND_THRESHOLD = "5";
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });

    cutover = await import("./cutover");
    recordsSvc = await import("@/lib/services/records");
    appPool = (await import("@/lib/db")).db.$client as Pool;

    await testDb.insert(schema.user).values({ id: USER_ID, email: "cutover@hutch.test", name: "Cutover" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "cutover", name: "Cutover", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
    // The legacy shared table, as migrations 0000-0020 left it.
    await testDb.execute(sql`DROP TABLE IF EXISTS records`);
    await testDb.execute(sql`
      CREATE TABLE records (
        id serial PRIMARY KEY,
        collection_id integer NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        data jsonb NOT NULL,
        source text,
        status text DEFAULT 'active',
        deleted_at timestamptz,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )`);
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** A collection as an old database has it: a row in collections, its rows in records, no table. */
  async function legacyCollection(slug: string, docs: { data: unknown; deleted?: boolean; status?: string | null; at?: string }[], uniqueKey: string[] = []): Promise<number> {
    const [row] = await testDb.insert(schema.collections).values({ organizationId: ORG_ID, name: slug, slug, uniqueKey }).returning();
    await testDb.insert(schema.collectionMembers).values({ collectionId: row.id, userId: USER_ID, role: "owner" });
    for (const d of docs) {
      await testDb.execute(sql`
        INSERT INTO records (collection_id, data, source, status, deleted_at, created_at, updated_at)
        VALUES (${row.id}, ${JSON.stringify(d.data)}::jsonb, 'api', ${d.status === undefined ? "active" : d.status},
                ${d.deleted ? sql`now() - interval '1 hour'` : sql`NULL`},
                ${d.at ?? "2026-01-01T00:00:00Z"}::timestamptz, ${d.at ?? "2026-01-01T00:00:00Z"}::timestamptz + interval '1 minute')`);
    }
    return row.id;
  }

  async function rows(sqlText: ReturnType<typeof sql>) {
    return (await testDb.execute(sqlText)).rows as Record<string, unknown>[];
  }

  async function storageOf(id: number) {
    const [row] = await rows(sql`SELECT storage FROM collections WHERE id = ${id}`);
    return row.storage as Record<string, unknown> & { cutover?: { rows: number; data_md5: string; inferred_at?: string }; projections?: { field: string }[]; unique_key?: string[] };
  }

  it("copies every collection with ids, timestamps, status and soft deletes kept, then infers; a re-run does nothing", async () => {
    // Interleave two collections' rows so record ids are not contiguous per collection.
    const small = await legacyCollection("small", [{ data: { name: "only" } }]);
    const bigDocs = Array.from({ length: 12 }, (_, i) => ({
      data: { title: `t${i}`, n: i, tags: ["a"], nested: { k: i % 3 } },
      deleted: i === 3,
      status: i === 4 ? null : i === 5 ? "archived" : "active",
      at: `2026-02-${String(i + 1).padStart(2, "0")}T10:00:00.123456Z`,
    }));
    const big = await legacyCollection("big", bigDocs, ["title"]);
    await testDb.execute(sql`INSERT INTO records (collection_id, data) VALUES (${small}, '{"name": "second"}')`);
    const empty = await legacyCollection("empty", []);

    const before = await rows(sql`SELECT id, collection_id, data, source, status, deleted_at::text, created_at::text, updated_at::text FROM records ORDER BY id`);
    const log: string[] = [];
    const report = await cutover.runCutover({ log: (l) => log.push(l) });

    // Smallest first.
    expect(report.copied.map((c) => [c.slug, c.status, c.rows])).toEqual([["empty", "empty", 0], ["small", "copied", 2], ["big", "copied", 12]]);
    expect(report.copied.every((c) => c.warnings.length === 0)).toBe(true);

    for (const id of [small, big]) {
      const copied = await rows(sql`SELECT id, ${id}::int AS collection_id, data, source, status, deleted_at::text, created_at::text, updated_at::text FROM ${sql.identifier(`hc_${id}`)} ORDER BY id`);
      expect(copied).toEqual(before.filter((r) => r.collection_id === id));
      expect((await storageOf(id)).cutover?.rows).toBe(copied.length);
    }
    expect(await rows(sql`SELECT to_regclass(${`hc_${empty}`}) IS NOT NULL AS present`)).toEqual([{ present: true }]);

    // Inference ran over big's 11 live documents as one batch.
    const bigReport = report.inference.find((r) => r.slug === "big")!;
    expect(bigReport.docs).toBe(11);
    expect(bigReport.projections.map((p) => p.field)).toEqual(expect.arrayContaining(["title", "n"]));
    const reg = await storageOf(big);
    expect(reg.cutover?.inferred_at).toBeTruthy();
    expect(reg.projections?.map((p) => p.field)).toEqual(expect.arrayContaining(["title", "n"]));
    expect(reg.unique_key).toEqual(["title"]);
    expect(log.some((l) => l.startsWith("  inferred big"))).toBe(true);

    // The service reads the copied rows, including the soft delete.
    const page = ok(await recordsSvc.queryRecords("big", USER_ID, { sort: "n", limit: 100 }));
    if (!("records" in page)) throw new Error("expected records");
    expect(page.total).toBe(11);
    expect(page.records.map((r) => (r.data as { n: number }).n)).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);

    // The sequence was moved past the copied ids: a new record does not collide.
    const maxId = Math.max(...before.map((r) => Number(r.id)));
    const stored = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection: "small", data: { name: "new" } }));
    expect(Number((stored as unknown as { record: { id: number } }).record.id)).toBeGreaterThan(Math.max(...before.filter((r) => r.collection_id === small).map((r) => Number(r.id))));
    expect(maxId).toBeGreaterThan(0);
    // ...and the unique key is enforced by the new table's index.
    const conflict = await recordsSvc.createRecords(USER_ID, ORG_ID, { collection: "big", data: { title: "t1" }, on_conflict: "error" });
    expect(conflict).toMatchObject({ status: 409 });

    // A second run copies nothing and infers nothing.
    const again = await cutover.runCutover();
    expect(again.copied.map((c) => c.status)).toEqual(["already done", "already done", "already done"]);
    expect(again.inference).toEqual([]);
    expect((await rows(sql`SELECT count(*)::int AS n FROM ${sql.identifier(`hc_${small}`)}`))[0].n).toBe(3);
  });

  it("a dry run copies and verifies, then leaves nothing behind", async () => {
    const id = await legacyCollection("dry", [{ data: { a: 1 } }, { data: { a: 2 } }]);
    const report = await cutover.runCutover({ dryRun: true });
    expect(report.copied.map((c) => [c.slug, c.status])).toEqual([["dry", "copied"]]);
    expect(report.inference).toEqual([]);
    expect(await rows(sql`SELECT to_regclass(${`hc_${id}`}) IS NULL AS gone`)).toEqual([{ gone: true }]);
    expect((await storageOf(id)).cutover).toBeUndefined();
  });

  it("a failure in any collection rolls back every collection's copy", async () => {
    const first = await legacyCollection("first", [{ data: { a: 1 } }]);
    const second = await legacyCollection("second", [{ data: { a: 1 } }, { data: { a: 2 } }]);
    // The new code already wrote into second's table: ids would collide.
    await testDb.execute(sql`CREATE TABLE ${sql.identifier(`hc_${second}`)} (id serial PRIMARY KEY, data jsonb NOT NULL, source text, status text DEFAULT 'active', deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
    await testDb.execute(sql`INSERT INTO ${sql.identifier(`hc_${second}`)} (data) VALUES ('{"a": 9}')`);

    await expect(cutover.runCutover()).rejects.toThrow(cutover.CutoverError);
    await expect(cutover.runCutover()).rejects.toThrow(/second: hc_\d+ already holds 1 rows/);
    expect(await rows(sql`SELECT to_regclass(${`hc_${first}`}) IS NULL AS gone`)).toEqual([{ gone: true }]);
    expect((await storageOf(first)).cutover).toBeUndefined();
    expect((await rows(sql`SELECT count(*)::int AS n FROM records`))[0].n).toBe(3);
  });

  it("leaves a unique_key with existing duplicates unindexed and reports it", async () => {
    const id = await legacyCollection("dupes", [{ data: { k: "x" } }, { data: { k: "x" } }, { data: { k: "y" } }, { data: { other: 1 } }], ["k"]);
    const report = await cutover.runCutover();
    expect(report.copied[0].warnings).toEqual(["unique_key [k] has 1 duplicate group(s); its unique index was not created"]);
    expect((await storageOf(id)).unique_key).toBeUndefined();
    expect(await rows(sql`SELECT to_regclass(${`hc_${id}_uk`}) IS NULL AS absent`)).toEqual([{ absent: true }]);
  });

  it("drops records only when every collection still matches what was copied", async () => {
    const id = await legacyCollection("dropme", [{ data: { a: 1 } }, { data: { a: 2 }, deleted: true }]);
    await cutover.runCutover();

    // A row that reached records after the copy blocks the drop.
    await testDb.execute(sql`INSERT INTO records (collection_id, data) VALUES (${id}, '{"late": true}')`);
    await expect(cutover.runCutover({ dropRecords: true })).rejects.toThrow(/dropme: records holds 3 rows, 2 were copied/);
    expect(await cutover.recordsTableExists()).toBe(true);

    await testDb.execute(sql`DELETE FROM records WHERE data ? 'late'`);
    const report = await cutover.runCutover({ dropRecords: true });
    expect(report.dropped).toBe(true);
    expect(await cutover.recordsTableExists()).toBe(false);

    // The collection keeps working, and a further run has nothing to do.
    const page = ok(await recordsSvc.queryRecords("dropme", USER_ID, {}));
    expect(page.total).toBe(1);
    expect(await cutover.runCutover({ dropRecords: true })).toMatchObject({ recordsTable: "absent", copied: [], dropped: false });
  });
});
