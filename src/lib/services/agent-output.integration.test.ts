import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Bounded tool output against real Postgres: describe and get_collection
// list one page of fields on a wide collection, describe shows type drift
// consistently (field type, typeCounts, mixed projection), and query/search
// results cut long strings and keep a page under the size budget.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;
const USER_ID = "agent-output-user";
const ORG_ID = "agent-output-org";

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");

describe.skipIf(!TEST_DB_URL)("bounded tool output, real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  const saved = { url: process.env.HUTCH_DATABASE_URL, threshold: process.env.HUTCH_PROJECT_THRESHOLD };

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    // Project fields once a collection holds a handful of records.
    process.env.HUTCH_PROJECT_THRESHOLD = "5";
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    await migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    appPool = (await import("@/lib/db")).db.$client as Pool;
    await testDb.insert(schema.user).values({ id: USER_ID, email: "agent-output@hutch.test", name: "Output" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "agent-output", name: "Output", personal: true }).onConflictDoNothing();
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
    for (const [key, value] of [["HUTCH_DATABASE_URL", saved.url], ["HUTCH_PROJECT_THRESHOLD", saved.threshold]] as const) {
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

  type Described = {
    fields: { name: string; type: string; conflict?: boolean; types?: string[]; typeCounts?: Record<string, number> }[];
    fields_total: number; fields_offset: number; fields_returned: number; fields_omitted: number; fields_next_offset: number | null;
    fields_matching_prefix?: number; fields_hint?: string;
    storage: { projections: { field: string; type: string; mixed?: boolean; reason: string }[] };
  };

  /** 100 records: 4 fields in every record, plus 2 sparse fields each (attr_000 ... attr_199). */
  function wideRecords(): Record<string, unknown>[] {
    return Array.from({ length: 100 }, (_, i) => ({
      sku: `P${i}`, name: `Product ${i}`, price: i, category: i % 2 ? "a" : "b",
      [`attr_${String(2 * i).padStart(3, "0")}`]: "x", [`attr_${String(2 * i + 1).padStart(3, "0")}`]: i,
    }));
  }

  describe("describe and get_collection on a wide collection", () => {
    it("lists the 60 most common fields by default, with totals and the next offset", async () => {
      const { slug } = await seed("wide_catalog", wideRecords());
      const d = (await collectionsSvc.describeCollection(slug, USER_ID)) as unknown as Described;
      expect(d.fields).toHaveLength(60);
      expect(d.fields.slice(0, 4).map((f) => f.name).sort()).toEqual(["category", "name", "price", "sku"]);
      expect(d).toMatchObject({ fields_total: 204, fields_offset: 0, fields_returned: 60, fields_omitted: 144, fields_next_offset: 60 });
      expect(d.fields_hint).toMatch(/Fields 1–60 of 204 .*fields_offset: 60/);
    });

    it("pages with fields_offset and stops at the end", async () => {
      const { slug } = await seed("wide_catalog_pages", wideRecords());
      const seen = new Set<string>();
      let offset: number | null = 0;
      let calls = 0;
      while (offset !== null) {
        const d = (await collectionsSvc.describeCollection(slug, USER_ID, { fields_offset: offset })) as unknown as Described;
        for (const f of d.fields) seen.add(f.name);
        offset = d.fields_next_offset;
        calls++;
      }
      expect(calls).toBe(4);
      expect(seen.size).toBe(204);
    });

    it("filters by field_prefix", async () => {
      const { slug } = await seed("wide_catalog_prefix", wideRecords());
      const d = (await collectionsSvc.describeCollection(slug, USER_ID, { field_prefix: "attr_01" })) as unknown as Described;
      expect(d.fields.map((f) => f.name)).toEqual(Array.from({ length: 10 }, (_, i) => `attr_01${i}`));
      expect(d).toMatchObject({ fields_total: 204, fields_matching_prefix: 10, fields_omitted: 0, fields_next_offset: null });
      expect(d.fields_hint).toBeUndefined();
    });

    it("leaves a narrow collection's describe whole", async () => {
      const { slug } = await seed("narrow", [{ a: 1, b: "x" }, { a: 2, b: "y" }]);
      const d = (await collectionsSvc.describeCollection(slug, USER_ID)) as unknown as Described;
      expect(d).toMatchObject({ fields_total: 2, fields_returned: 2, fields_omitted: 0, fields_next_offset: null });
    });

    it("get_collection pages schema.fields the same way, and returns the whole schema without a page", async () => {
      const { slug } = await seed("wide_catalog_schema", wideRecords());
      const paged = (await collectionsSvc.getCollection(slug, USER_ID, {})) as unknown as { schema: { fields: { name: string }[] }; fields_total: number; fields_next_offset: number | null; storage: unknown };
      expect(paged.schema.fields).toHaveLength(60);
      expect(paged.fields_total).toBe(204);
      expect(paged.fields_next_offset).toBe(60);
      expect(paged.storage).toBeDefined();
      const second = (await collectionsSvc.getCollection(slug, USER_ID, { fields_offset: 200 })) as unknown as { schema: { fields: unknown[] }; fields_next_offset: number | null };
      expect(second.schema.fields).toHaveLength(4);
      expect(second.fields_next_offset).toBeNull();
      const whole = (await collectionsSvc.getCollection(slug, USER_ID)) as unknown as { schema: { fields: unknown[] } };
      expect(whole.schema.fields).toHaveLength(204);
    });
  });

  describe("describe on type drift", () => {
    it("types the field by its most common type, counts each type, and marks the projection mixed", async () => {
      const { slug } = await seed("drift", Array.from({ length: 12 }, (_, i) => ({ name: `item-${i}`, score: 1000 + i })));
      const before = (await collectionsSvc.describeCollection(slug, USER_ID)) as unknown as Described;
      const projection = before.storage.projections.find((p) => p.field === "score");
      expect(projection).toMatchObject({ type: "number" });
      expect(projection?.mixed).toBeUndefined();

      await seed("drift", [{ name: "s1", score: "5000" }, { name: "s2", score: "6000" }]);
      const after = (await collectionsSvc.describeCollection(slug, USER_ID)) as unknown as Described;
      const field = after.fields.find((f) => f.name === "score")!;
      expect(field).toMatchObject({ type: "number", conflict: true, typeCounts: { number: 12, string: 2 } });
      const mixed = after.storage.projections.find((p) => p.field === "score")!;
      expect(mixed.mixed).toBe(true);
      expect(mixed.reason).toMatch(/now hold other types/);
      expect(mixed.reason).not.toMatch(/100%/);
    });
  });
});
