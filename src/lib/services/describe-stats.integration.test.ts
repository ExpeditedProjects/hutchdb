import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// describe_collection and collection_stats against real Postgres: soft-
// deleted records count nowhere (distinct estimates, unwound element rows,
// fill rates); collections too large to scan get sampled fill rates and
// estimated distinct counts, labelled as such; the storage section is one
// short entry per index, narrowed on field_prefix lookups and left out of
// later fields_offset pages.
//
// "Too large to scan" is HUTCH_FULL_SCAN_MAX_BYTES, lowered per test.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;
const USER_ID = "describe-stats-user";
const ORG_ID = "describe-stats-org";

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");
type Builder = typeof import("@/lib/storage/builder");

type IndexEntry = { index: string; field: string; kind: string; state: string; serves?: string; mixed?: boolean };
type Described = {
  recordCount: number;
  fields: { name: string; frequency: number; distinctCount?: number; distinctCountEstimate?: number }[];
  storage?: { indexes: IndexEntry[]; unwinds: { path: string; rows?: number; state: string }[]; not_unwound: { path: string }[] } & Record<string, unknown>;
  storage_omitted?: string;
  fields_next_offset: number | null;
  fields_total: number;
};
type Stats = {
  record_count: number;
  fields: { name: string; count?: number; percent: number; estimated_count?: number }[];
  fields_sampled?: { rows: number; of: number };
  fields_note?: string;
};

describe.skipIf(!TEST_DB_URL)("describe and stats, real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  let builder: Builder;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD", "HUTCH_FULL_SCAN_MAX_BYTES"] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    process.env.HUTCH_PROJECT_THRESHOLD = "5";
    process.env.HUTCH_UNWIND_THRESHOLD = "20";
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    await migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    builder = await import("@/lib/storage/builder");
    appPool = (await import("@/lib/db")).db.$client as Pool;
    await testDb.insert(schema.user).values({ id: USER_ID, email: "describe-stats@hutch.test", name: "Stats" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "describe-stats", name: "Stats", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
  });

  afterEach(() => {
    delete process.env.HUTCH_FULL_SCAN_MAX_BYTES;
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function seed(collection: string, recs: Record<string, unknown>[]): Promise<{ slug: string; id: number; ids: number[] }> {
    const ids: number[] = [];
    let slug = "";
    // Batches keep each request well under the body limit.
    for (let i = 0; i < recs.length; i += 1000) {
      const result = await recordsSvc.createRecords(USER_ID, ORG_ID, { collection, records: recs.slice(i, i + 1000) });
      if ("error" in result) throw new Error(String(result.error));
      const r = result as unknown as { collection: { slug: string }; results: { record: { id: number } }[] };
      slug = r.collection.slug;
      ids.push(...r.results.map((x) => x.record.id));
    }
    const [coll] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    return { slug, id: coll.id, ids };
  }

  const describeOf = async (slug: string, page?: { fields_offset?: number; field_prefix?: string }) =>
    (await collectionsSvc.describeCollection(slug, USER_ID, page)) as unknown as Described;
  const statsOf = async (slug: string) => (await collectionsSvc.getCollectionStats(slug, USER_ID)) as unknown as Stats;

  describe("soft-deleted records", () => {
    it("are left out of distinct-count estimates (scaled by live records, never above them)", async () => {
      const { slug, id, ids } = await seed("estimates", Array.from({ length: 100 }, (_, i) => ({ name: `item-${i}`, group: `g${i % 4}` })));
      await builder.buildPendingIndexes();
      for (const recordId of ids.slice(0, 40)) await recordsSvc.deleteRecord(slug, USER_ID, recordId);
      await testDb.execute(sql`ANALYZE ${sql.identifier(`hc_${id}`)}`);
      await testDb.execute(sql`ANALYZE ${sql.identifier(`hc_${id}_p_name_idx`)}`);
      // Too large to scan: estimates instead of exact counts.
      process.env.HUTCH_FULL_SCAN_MAX_BYTES = "0";
      const d = await describeOf(slug);
      expect(d.recordCount).toBe(60);
      const name = d.fields.find((f) => f.name === "name")!;
      expect(name.distinctCount).toBeUndefined();
      expect(name.distinctCountEstimate).toBe(60);
    });

    it("are left out of exact distinct counts and fill rates", async () => {
      const { slug, ids } = await seed("exact", Array.from({ length: 10 }, (_, i) => ({ name: `item-${i}`, ...(i === 0 ? { only_first: true } : {}) })));
      await recordsSvc.deleteRecord(slug, USER_ID, ids[0]);
      const d = await describeOf(slug);
      expect(d.fields.find((f) => f.name === "name")?.distinctCount).toBe(9);
      const stats = await statsOf(slug);
      expect(stats.record_count).toBe(9);
      expect(stats.fields).toEqual([{ name: "name", count: 9, percent: 100 }]);
      expect(stats.fields_sampled).toBeUndefined();
    });

    it("are left out of an unwound array's rows, which report the live element count, not the count when it was unwound", async () => {
      const order = (n: number, items: number) => ({ order_id: `o-${n}`, items: Array.from({ length: items }, (_, j) => ({ sku: `s-${j}`, qty: j + 1 })) });
      const { slug, ids } = await seed("orders", Array.from({ length: 6 }, (_, i) => order(i, 5)));
      await builder.buildPendingIndexes();
      const before = await describeOf(slug);
      expect(before.storage!.unwinds).toEqual([{ path: "items", rows: 30, state: "ready" }]);
      // More elements arrive after the unwind decision; one order is deleted.
      await seed("orders", [order(6, 7), order(7, 7)]);
      await recordsSvc.deleteRecord(slug, USER_ID, ids[0]);
      const after = await describeOf(slug);
      expect(after.storage!.unwinds).toEqual([{ path: "items", rows: 30 - 5 + 14, state: "ready" }]);
      expect(JSON.stringify(after.storage)).not.toMatch(/holds \d+ elements/);
    });
  });

  describe("collections too large to scan", () => {
    const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `item-${i}`, ...(i % 2 === 0 ? { half: i } : {}) }));

    it("collection_stats samples fill rates and says so; counts stay exact", async () => {
      const { slug, ids } = await seed("big", docs(6000));
      await recordsSvc.deleteRecord(slug, USER_ID, ids[1]);
      process.env.HUTCH_FULL_SCAN_MAX_BYTES = "0";
      const stats = await statsOf(slug);
      expect(stats.record_count).toBe(5999);
      expect(stats.fields_sampled!.of).toBe(5999);
      expect(stats.fields_sampled!.rows).toBeGreaterThan(4000);
      expect(stats.fields_sampled!.rows).toBeLessThanOrEqual(5000);
      expect(stats.fields_note).toMatch(/random sample of \d+ of 5999 records/);
      const name = stats.fields.find((f) => f.name === "name")!;
      expect(name).toEqual({ name: "name", percent: 100, estimated_count: 5999 });
      const half = stats.fields.find((f) => f.name === "half")!;
      expect(half.count).toBeUndefined();
      expect(half.percent).toBeGreaterThan(40);
      expect(half.percent).toBeLessThan(60);
      expect(Math.abs(half.estimated_count! - 3000)).toBeLessThan(600);
    });

    it("collection_stats counts every record exactly when the collection fits a scan", async () => {
      const { slug } = await seed("big_exact", docs(6000));
      const stats = await statsOf(slug);
      expect(stats.fields_sampled).toBeUndefined();
      expect(stats.fields_note).toBeUndefined();
      expect(stats.fields).toEqual([{ name: "name", count: 6000, percent: 100 }, { name: "half", count: 3000, percent: 50 }]);
    });

    it("describe gives estimates instead of exact distinct counts, and samples 500 records", async () => {
      const { slug } = await seed("big_describe", docs(6000));
      await builder.buildPendingIndexes();
      const exact = await describeOf(slug);
      expect(exact.fields.find((f) => f.name === "name")?.distinctCount).toBe(6000);
      process.env.HUTCH_FULL_SCAN_MAX_BYTES = "0";
      const d = await describeOf(slug);
      const name = d.fields.find((f) => f.name === "name")!;
      expect(name.frequency).toBe(1);
      expect(name.distinctCount).toBeUndefined();
      expect(d.fields.find((f) => f.name === "half")!.frequency).toBeGreaterThan(0.35);
    });
  });

  describe("describe pages come from one sample", () => {
    // ~200 sparse fields with close fill rates: their order depends on which records are sampled.
    const sparse = (n: number) => Array.from({ length: n }, (_, i) => {
      const doc: Record<string, unknown> = { n: i };
      for (let f = 0; f < 200; f++) if ((i * 7919 + f * 104729) % 97 < (f % 40) + 5) doc[`s_${String(f).padStart(3, "0")}`] = f;
      return doc;
    });

    for (const [label, n] of [["a table sorted whole", 600], ["a TABLESAMPLE table", 2600]] as const) {
      it(`fields_offset pages over ${label} neither skip nor repeat fields, and fields_total holds`, async () => {
        const { slug, id } = await seed(`pages_${n}`, sparse(n));
        const first = await describeOf(slug);
        const again = await describeOf(slug);
        const second = await describeOf(slug, { fields_offset: 60 });
        const names = (d: Described) => d.fields.map((f) => f.name);
        expect(names(again)).toEqual(names(first));
        expect(second.fields_total).toBe(first.fields_total);
        const union = [...names(first), ...names(second)];
        expect(new Set(union).size).toBe(120);
        // No gaps: the two pages are the first 120 fields of the one list.
        const { describeFields } = await import("@/lib/describe");
        const whole = await describeFields(id, n, null, { limit: 120 });
        expect(whole.fields.map((f) => f.name)).toEqual(union);
        // Frequencies are over the records actually sampled: a field every record has is at 1.
        expect(first.fields.find((f) => f.name === "n")?.frequency).toBe(1);
      }, 30_000);
    }
  });

  describe("compact storage section", () => {
    const wide = () => Array.from({ length: 30 }, (_, i) => ({
      sku: `P${i}`, price: i, ...Object.fromEntries(Array.from({ length: 70 }, (_, k) => [`attr_${String(k).padStart(2, "0")}`, k])),
      lines: Array.from({ length: 2 }, (_, j) => ({ code: `c${j}`, n: j })),
    }));

    it("lists one short entry per index: name, field, kind, state; serves only on the documents GIN", async () => {
      const { slug, id } = await seed("compact", wide());
      await builder.buildPendingIndexes();
      const d = await describeOf(slug);
      const storage = d.storage!;
      expect(Object.keys(storage).sort()).toEqual(["indexes", "not_unwound", "unwinds"]);
      expect(storage.indexes[0]).toMatchObject({ index: `hc_${id}_data_gin_idx`, field: "*", kind: "documents (GIN)", state: "ready" });
      expect(storage.indexes[0].serves).toMatch(/equality on any field or path/);
      for (const entry of storage.indexes.slice(1)) {
        expect(Object.keys(entry).sort()).toEqual(["field", "index", "kind", "state"]);
      }
      expect(storage.indexes).toContainEqual({ index: `hc_${id}_p_attr_00_idx`, field: "attr_00", kind: "number", state: "ready" });
      expect(storage.indexes.find((i) => i.field === "lines.code")).toMatchObject({ kind: "text, unwound array element", state: "ready" });
      expect(JSON.stringify(storage).length).toBeLessThan(150 * storage.indexes.length + 400);
    });

    it("narrows storage to the matching fields on a field_prefix lookup", async () => {
      const { slug } = await seed("compact_prefix", wide());
      await builder.buildPendingIndexes();
      const d = await describeOf(slug, { field_prefix: "lines" });
      expect(d.storage!.indexes.map((i) => i.field).sort()).toEqual(["lines.code", "lines.n"]);
      expect(d.storage!.unwinds.map((u) => u.path)).toEqual(["lines"]);
      const none = await describeOf(slug, { field_prefix: "sku" });
      expect(none.storage!.unwinds).toEqual([]);
      expect(none.storage!.indexes.every((i) => i.field.startsWith("sku"))).toBe(true);
    });

    it("leaves storage out of later fields_offset pages", async () => {
      const { slug } = await seed("compact_pages", wide());
      const first = await describeOf(slug);
      expect(first.storage).toBeDefined();
      expect(first.fields_next_offset).toBe(60);
      const second = await describeOf(slug, { fields_offset: 60 });
      expect(second.storage).toBeUndefined();
      expect(second.storage_omitted).toMatch(/first page/);
    });
  });
});
