import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Database failures as agents see them, against real Postgres: a statement
// timeout and an invalid-input error are classified from what drizzle and
// node-postgres actually throw; a request that names a field no record has
// fails as a validation error even when checking for the field times out;
// a transform that times out says so (and that nothing changed) instead of
// "check the field names"; a malformed set_field.filter says what is wrong.
//
// Timeouts are made deterministic by holding an ACCESS EXCLUSIVE lock on the
// collection table from another connection (as a projection ALTER does in
// production): the app's statement_timeout, lowered for this file, then
// cancels the blocked statement with SQLSTATE 57014.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;
const USER_ID = "tool-errors-user";
const ORG_ID = "tool-errors-org";
const TIMEOUT_MS = "400";

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");
type Errors = typeof import("@/lib/db/errors");

describe.skipIf(!TEST_DB_URL)("database errors and validation, real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  let errors: Errors;
  let appDb: typeof import("@/lib/db").db;
  const saved = { url: process.env.HUTCH_DATABASE_URL, timeout: process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS };

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS = TIMEOUT_MS;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    await migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    errors = await import("@/lib/db/errors");
    appDb = (await import("@/lib/db")).db;
    appPool = appDb.$client as Pool;
    await testDb.insert(schema.user).values({ id: USER_ID, email: "tool-errors@hutch.test", name: "Errors" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "tool-errors", name: "Errors", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    for (const [key, value] of [["HUTCH_DATABASE_URL", saved.url], ["HUTCH_DB_STATEMENT_TIMEOUT_MS", saved.timeout]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function seed(collection: string, recs: Record<string, unknown>[]): Promise<{ slug: string; id: number }> {
    const result = await recordsSvc.createRecords(USER_ID, ORG_ID, { collection, records: recs, return: "summary" });
    if ("error" in result) throw new Error(String(result.error));
    const slug = (result as { collection: { slug: string } }).collection.slug;
    const [coll] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    return { slug, id: coll.id };
  }

  /** Run `fn` while another connection holds an ACCESS EXCLUSIVE lock on hc_<id>. */
  async function whileLocked<T>(collectionId: number, fn: () => Promise<T>): Promise<T> {
    const client: PoolClient = await testPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`LOCK TABLE hc_${collectionId} IN ACCESS EXCLUSIVE MODE`);
      return await fn();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  const LEAKS = [/hc_\d+/, /SELECT|UPDATE|INSERT/, /Failed query/, /params:/, /postgres(ql)?:\/\//i];

  it("classifies a real statement timeout and describes it without SQL", async () => {
    const err = await appDb.execute(sql`SELECT pg_sleep(3)`).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(errors.isDatabaseError(err)).toBe(true);
    expect(errors.classifyDbError(err)).toBe("timeout");
    const text = errors.describeDbError(err, { tool: "hutch_query_records", collection: "articles" });
    expect(text).toMatch(/^hutch_query_records timed out after 400ms on collection 'articles'\./);
    for (const leak of LEAKS) expect(text).not.toMatch(leak);
  });

  it("classifies a bad created_after as invalid input naming the expected type", async () => {
    const { slug } = await seed("events_bad_date", [{ a: 1 }]);
    const err = await recordsSvc.queryRecords(slug, USER_ID, { createdAfter: "not a date" }).then(() => null, (e: unknown) => e);
    expect(errors.classifyDbError(err)).toBe("invalid_input");
    const text = errors.describeDbError(err, { tool: "hutch_query_records", collection: slug });
    expect(text).toMatch(/does not match the type/);
    expect(text).toMatch(/expected timestamp with time zone/);
    expect(text).not.toMatch(/not a date/);
    for (const leak of LEAKS) expect(text).not.toMatch(leak);
  });

  it("an unknown field in `fields` is a validation error naming the field, even when the existence check times out", async () => {
    const { slug, id } = await seed("articles_fields", [{ title: "A", author: "x" }, { title: "B", author: "y" }]);
    const err = await whileLocked(id, () =>
      recordsSvc.queryRecords(slug, USER_ID, { fields: ["title", "category"] }).then(() => null, (e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(errors.isDatabaseError(err)).toBe(false);
    expect(err.message).toMatch(/^Unknown field 'category': 'category' is not in this collection's saved schema, and checking every record for it timed out \(400ms\)\./);
    expect(err.message).toMatch(/Known top-level fields: .*title/);
  });

  it("without contention the unknown field is still the documented 'no record has it' error", async () => {
    const { slug } = await seed("articles_fields_fast", [{ title: "A" }]);
    await expect(recordsSvc.queryRecords(slug, USER_ID, { fields: ["category"] })).rejects.toThrow(/Invalid field 'category' in fields: no record in this collection has it/);
  });

  it("an unknown sort field whose check times out is a validation error too", async () => {
    const { slug, id } = await seed("articles_sort", [{ title: "A" }]);
    const err = await whileLocked(id, () =>
      recordsSvc.queryRecords(slug, USER_ID, { sort: "-publshed_at" }).then(() => null, (e: unknown) => e)) as Error;
    expect(errors.isDatabaseError(err)).toBe(false);
    expect(err.message).toMatch(/^Unknown sort field 'publshed_at'/);
  });

  it("a transform that times out says so, and that nothing changed, instead of 'check the field names'", async () => {
    const { slug, id } = await seed("orders_transform", [{ status: "delivered", n: 1 }, { status: "paid", n: 2 }]);
    const result = await whileLocked(id, () =>
      recordsSvc.transformRecords(slug, USER_ID, { set_field: { field: "audited", value: true, filter: { status: "delivered" } } }));
    expect(result).toHaveProperty("error");
    const message = (result as { error: string }).error;
    expect(message).toMatch(new RegExp(`^Transform timed out after 400ms on collection '${slug}' and was rolled back: no records were changed\\.`));
    expect(message).toMatch(/Narrow set_field\.filter/);
    expect(message).not.toMatch(/check the field names/);
    for (const leak of LEAKS) expect(message).not.toMatch(leak);
    const rows = await testDb.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(`hc_${id}`)} WHERE data ? 'audited'`);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("a malformed set_field.filter reports the filter problem, not a database failure", async () => {
    const { slug } = await seed("orders_bad_filter", [{ status: "delivered" }]);
    const result = await recordsSvc.transformRecords(slug, USER_ID, { set_field: { field: "x", value: 1, filter: { status: { $regex: "del" } } } });
    expect(result).toEqual({ error: expect.stringMatching(/^Invalid set_field\.filter: Unsupported filter operator '\$regex'/), status: 400 });
  });

  it("storageTimeoutHint names indexes that failed or are still building, and is silent when all are ready", async () => {
    const { slug, id } = await seed("articles_hint", [{ title: "A" }]);
    expect(await collectionsSvc.storageTimeoutHint(slug, USER_ID)).toBeUndefined();
    const at = "2026-10-20T00:00:00Z";
    const proj = (field: string, column: string, build: object, path?: string[]) =>
      ({ field, column, type: "text", reason: "r", kind: "expression", build, ...(path ? { path } : {}) });
    const failedBuild = { state: "failed", at, attempts: 1, error: "index build failed", retry_after: at };
    const storage = {
      projections: [
        proj("author", "p_author", failedBuild),
        proj("totals.points", "p_totals_points", failedBuild, ["totals", "points"]),
        proj("title", "p_title", { state: "pending", at }),
        proj("ready_one", "p_ready_one", { state: "ready", at }),
      ],
      unwinds: [],
      evaluated_rows: 1,
      search_index: { reason: "r", build: { state: "building", at } },
    };
    await testDb.update(schema.collections).set({ storage }).where(eq(schema.collections.id, id));
    const hint = await collectionsSvc.storageTimeoutHint(slug, USER_ID);
    expect(hint).toMatch(/^Building indexes for 'author', 'totals\.points' on this collection failed and will be retried; indexes for 'title', full-text search are still being built in the background/);
    expect(hint).not.toMatch(/ready_one/);
    expect(hint).not.toMatch(/hc_\d+/);

    const allReady = { ...storage, projections: [proj("author", "p_author", { state: "ready", at }), { field: "legacy", column: "p_legacy", type: "number", reason: "r" }], search_index: undefined };
    await testDb.update(schema.collections).set({ storage: allReady }).where(eq(schema.collections.id, id));
    expect(await collectionsSvc.storageTimeoutHint(slug, USER_ID)).toBeUndefined();
  });
});
