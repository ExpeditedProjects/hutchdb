import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq, asc } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Real-Postgres integration tier. No mocks — every service call in this file
// executes its actual generated SQL against a scratch database.
//
// Why this exists: three production bugs shipped because unit tests mock the
// DB. (1) transform_records' rename SQL failed on real Postgres — untyped
// bind params are ambiguous for `->`/`-` and fail outright in
// jsonb_build_object (VARIADIC "any") under node-postgres ("could not
// determine data type of parameter"). (2) transform with no ops silently
// succeeded. (3) list_collections dumped full schemas. This tier's job:
// every piece of generated SQL must actually run.
//
// Auto-skipped when HUTCH_TEST_DATABASE_URL is not set, so plain `npm test`
// stays green without any infrastructure.
//
// To run locally:
//
//   createdb hutch_test
//   HUTCH_TEST_DATABASE_URL=postgresql://localhost/hutch_test npm test
//
// DB wiring choice: service modules import `db` from `@/lib/db`, which builds
// a pg Pool from process.env.HUTCH_DATABASE_URL at module-load time. Rather
// than vi.mock'ing `@/lib/db` (which would swap out the very module chain we
// are trying to exercise), we overwrite HUTCH_DATABASE_URL with the test URL
// in beforeAll and only then dynamically import the service modules. This
// file runs in its own vitest worker (the `integration` project), so the
// override can't leak into unit tests, and the REAL `@/lib/db` pool — with
// its production statement_timeout settings — runs against the scratch DB.
// The suite's own drizzle client (for migrate/seed/truncate/asserts) is built
// directly from HUTCH_TEST_DATABASE_URL and never touches `@/lib/db`.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "integration-user";
const USER_EMAIL = "integration@hutch.test";
const ORG_ID = "integration-org";

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");

/** Narrow a service result to its success shape, failing loudly otherwise. */
function ok<T>(result: T): Exclude<T, { error: unknown } | null | undefined> {
  if (result == null || (typeof result === "object" && "error" in (result as object))) {
    throw new Error(`Expected success result, got: ${JSON.stringify(result)}`);
  }
  return result as Exclude<T, { error: unknown } | null | undefined>;
}

describe.skipIf(!TEST_DB_URL)("services against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;

  beforeAll(async () => {
    // Point the app module chain at the scratch DB BEFORE importing it.
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;

    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });

    // Apply the repo's real migration chain to the scratch database.
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });

    // Now that the env var points at the scratch DB, load the real modules.
    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    const dbModule = await import("@/lib/db");
    appPool = dbModule.db.$client as Pool;

    // Minimal viable FK graph: one user, one org, one membership. Collections
    // and collection_members rows are created by the services themselves.
    await testDb
      .insert(schema.user)
      .values({ id: USER_ID, email: USER_EMAIL, name: "Integration" })
      .onConflictDoNothing();
    await testDb
      .insert(schema.organizations)
      .values({ id: ORG_ID, slug: "integration", name: "Integration", personal: true })
      .onConflictDoNothing();
    await testDb
      .insert(schema.organizationMembers)
      .values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    // Cascades to records, views, collection_members, collection_invitations.
    // The seeded user/org rows survive across tests.
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
  });

  /** Store records through the real service, returning the collection slug. */
  async function seed(collection: string, recs: Record<string, unknown>[]): Promise<string> {
    const result = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection, records: recs }));
    return (result as { collection: { slug: string } }).collection.slug;
  }

  /** Read a collection's live records straight from the scratch DB. */
  async function rawData(slug: string): Promise<Record<string, unknown>[]> {
    const [coll] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    const rows = await testDb
      .select()
      .from(schema.records)
      .where(eq(schema.records.collectionId, coll.id))
      .orderBy(asc(schema.records.id));
    return rows.filter((r) => r.deletedAt === null).map((r) => r.data as Record<string, unknown>);
  }

  async function query(slug: string, params: Parameters<RecordsService["queryRecords"]>[2]) {
    return ok(await recordsSvc.queryRecords(slug, USER_ID, params));
  }

  // ── a. transformRecords ───────────────────────────────────────────────────

  describe("transformRecords", () => {
    it("rename_fields executes on real Postgres and moves values (the regression)", async () => {
      const slug = await seed("transform_rename", [
        { old_name: "keep-me", other: 1 },
        { old_name: 42 },
        { unrelated: true }, // lacks the field — must be untouched
      ]);

      const result = ok(
        await recordsSvc.transformRecords(slug, USER_ID, { rename_fields: { old_name: "new_name" } }),
      );
      expect(result.updated).toBe(2);

      const data = await rawData(slug);
      expect(data[0]).toEqual({ new_name: "keep-me", other: 1 });
      expect(data[1]).toEqual({ new_name: 42 });
      expect(data[2]).toEqual({ unrelated: true });
    });

    it("remove_fields strips multiple fields in one statement", async () => {
      const slug = await seed("transform_remove", [
        { a: 1, b: 2, c: 3 },
        { a: 4, c: 5 },
      ]);

      const result = ok(await recordsSvc.transformRecords(slug, USER_ID, { remove_fields: ["a", "b"] }));
      expect(result.updated).toBeGreaterThan(0);

      const data = await rawData(slug);
      expect(data).toEqual([{ c: 3 }, { c: 5 }]);
    });

    it("set_field without filter overwrites every record", async () => {
      const slug = await seed("transform_set_all", [{ x: 1 }, { x: 2 }]);

      const result = ok(
        await recordsSvc.transformRecords(slug, USER_ID, {
          set_field: { field: "flag", value: { nested: true } },
        }),
      );
      expect(result.updated).toBe(2);

      const data = await rawData(slug);
      expect(data).toEqual([
        { x: 1, flag: { nested: true } },
        { x: 2, flag: { nested: true } },
      ]);
    });

    it("set_field with filter only touches matching records", async () => {
      const slug = await seed("transform_set_filtered", [
        { status: "active", n: 1 },
        { status: "done", n: 2 },
      ]);

      const result = ok(
        await recordsSvc.transformRecords(slug, USER_ID, {
          set_field: { field: "archived", value: true, filter: { status: "done" } },
        }),
      );
      expect(result.updated).toBe(1);

      const data = await rawData(slug);
      expect(data).toEqual([
        { status: "active", n: 1 },
        { status: "done", n: 2, archived: true },
      ]);
    });

    it("rejects a transform with no operations (regression: silent no-op success)", async () => {
      const slug = await seed("transform_empty", [{ a: 1 }]);
      const result = await recordsSvc.transformRecords(slug, USER_ID, {});
      expect(result).toMatchObject({ status: 400 });
      expect(result && "error" in result && result.error).toMatch(/No transform operation/);
    });
  });

  // ── b. filter operators via queryRecords ──────────────────────────────────

  describe("filter operators", () => {
    let slug: string;

    beforeEach(async () => {
      slug = await seed("operators", [
        { n: 5, s: "apple", tag: "a" },
        { n: 10, s: "banana", tag: "b" },
        { n: 15, s: "cherry" }, // no tag
        { n: "not-a-number", s: 99 }, // mixed types on n and s
        { note: "50%_off" },
        { note: "50x_off" },
        { note: "Hello World" },
      ]);
    });

    // Batch-inserted rows share a created_at, so result order is not
    // deterministic — assertions compare value sets sorted numerically.
    async function matchedN(filter: Record<string, unknown>): Promise<unknown[]> {
      const result = await query(slug, { filter });
      if (!("records" in result)) throw new Error("expected records shape");
      return result.records
        .map((r) => (r.data as Record<string, unknown>).n)
        .sort((a, b) => Number(a) - Number(b));
    }

    it("$gt/$gte/$lt/$lte with number operands skip non-numeric values without erroring", async () => {
      expect(await matchedN({ n: { $gt: 5 } })).toEqual([10, 15]);
      expect(await matchedN({ n: { $gte: 10 } })).toEqual([10, 15]);
      expect(await matchedN({ n: { $lt: 10 } })).toEqual([5]);
      expect(await matchedN({ n: { $lte: 10 } })).toEqual([5, 10]);
      expect(await matchedN({ n: { $gte: 5, $lt: 15 } })).toEqual([5, 10]);
    });

    it("$gt/$gte/$lt/$lte with string operands compare lexicographically on string values only", async () => {
      const result = await query(slug, { filter: { s: { $gte: "banana" } } });
      if (!("records" in result)) throw new Error("expected records shape");
      const values = result.records.map((r) => (r.data as Record<string, unknown>).s).sort();
      expect(values).toEqual(["banana", "cherry"]); // s: 99 (number) excluded, "apple" < "banana"

      const below = await query(slug, { filter: { s: { $lt: "banana" } } });
      if (!("records" in below)) throw new Error("expected records shape");
      expect(below.records.map((r) => (r.data as Record<string, unknown>).s)).toEqual(["apple"]);
    });

    it("$ne matches differing values AND records missing the field", async () => {
      const result = await query(slug, { filter: { tag: { $ne: "a" } } });
      if (!("records" in result)) throw new Error("expected records shape");
      const tags = result.records.map((r) => (r.data as Record<string, unknown>).tag);
      expect(tags).not.toContain("a");
      expect(result.total).toBe(6); // everything except the tag: "a" record
    });

    it("$in matches listed values; $nin includes records missing the field", async () => {
      const inResult = await query(slug, { filter: { tag: { $in: ["a", "b"] } } });
      if (!("records" in inResult)) throw new Error("expected records shape");
      expect(inResult.total).toBe(2);

      const ninResult = await query(slug, { filter: { tag: { $nin: ["a"] } } });
      if (!("records" in ninResult)) throw new Error("expected records shape");
      expect(ninResult.total).toBe(6); // tag: "b" plus the five records without tag

      const numericIn = await query(slug, { filter: { n: { $in: [5, 15] } } });
      if (!("records" in numericIn)) throw new Error("expected records shape");
      expect(numericIn.total).toBe(2);
    });

    it("$exists true/false split the collection by field presence", async () => {
      const withTag = await query(slug, { filter: { tag: { $exists: true } } });
      if (!("records" in withTag)) throw new Error("expected records shape");
      expect(withTag.total).toBe(2);

      const withoutTag = await query(slug, { filter: { tag: { $exists: false } } });
      if (!("records" in withoutTag)) throw new Error("expected records shape");
      expect(withoutTag.total).toBe(5);
    });

    it("$contains is case-insensitive substring", async () => {
      const result = await query(slug, { filter: { note: { $contains: "hello w" } } });
      if (!("records" in result)) throw new Error("expected records shape");
      expect(result.total).toBe(1);
      expect((result.records[0].data as Record<string, unknown>).note).toBe("Hello World");
    });

    it("$contains escapes % and _ so they match literally", async () => {
      // Unescaped, "0%_o" would ILIKE-match both "50%_off" and "50x_off".
      const result = await query(slug, { filter: { note: { $contains: "0%_o" } } });
      if (!("records" in result)) throw new Error("expected records shape");
      expect(result.total).toBe(1);
      expect((result.records[0].data as Record<string, unknown>).note).toBe("50%_off");
    });

    it("plain values use JSONB containment", async () => {
      const result = await query(slug, { filter: { tag: "a" } });
      if (!("records" in result)) throw new Error("expected records shape");
      expect(result.total).toBe(1);
      expect((result.records[0].data as Record<string, unknown>).n).toBe(5);
    });

    it("operators on a wholly mixed-type field never raise SQL errors", async () => {
      // n is number in some records, string in one, absent in others — every
      // operator must execute cleanly against real Postgres.
      for (const filter of [
        { n: { $gt: 0 } },
        { n: { $lte: "zzz" } },
        { n: { $ne: 5 } },
        { n: { $in: [5, "not-a-number"] } },
        { n: { $nin: [10] } },
        { n: { $exists: true } },
        { s: { $contains: "err" } },
      ]) {
        const result = await query(slug, { filter });
        expect("records" in result).toBe(true);
      }
    });
  });

  // ── c. aggregations ───────────────────────────────────────────────────────

  describe("aggregations", () => {
    let slug: string;

    beforeEach(async () => {
      slug = await seed("aggregations", [
        { team: "red", score: 10, label: "alpha" },
        { team: "red", score: 30, label: "beta" },
        { team: "blue", score: 5, label: "alpha" },
        { team: "blue", score: "n/a", label: "gamma" }, // non-numeric score
        { team: "text-only", score: "high" }, // group with ZERO numeric values
      ]);
    });

    async function aggregated(params: Parameters<RecordsService["queryRecords"]>[2]) {
      const result = await query(slug, params);
      if (!("results" in result)) throw new Error("expected aggregation shape");
      return result.results as Record<string, unknown>[];
    }

    it("count", async () => {
      const rows = await aggregated({ aggregate: { total: "count" } });
      expect(rows).toEqual([{ total: 5 }]);
    });

    it("min and max (text-based, per current engine semantics)", async () => {
      const rows = await aggregated({ aggregate: { lo: { min: "label" }, hi: { max: "label" } } });
      expect(rows).toEqual([{ lo: "alpha", hi: "gamma" }]);
    });

    it("distinct", async () => {
      const rows = await aggregated({ aggregate: { teams: { distinct: "team" } } });
      expect((rows[0].teams as string[]).sort()).toEqual(["blue", "red", "text-only"]);
    });

    it("sum and avg aggregate only numeric values", async () => {
      const rows = await aggregated({ aggregate: { total: { sum: "score" }, mean: { avg: "score" } } });
      // 10 + 30 + 5; "n/a" and "high" are ignored by the jsonb_typeof guard.
      expect(Number(rows[0].total)).toBe(45);
      expect(Number(rows[0].mean)).toBeCloseTo(15);
    });

    it("avg of an all-non-numeric group returns null (not an error)", async () => {
      const rows = await aggregated({
        groupBy: "team",
        aggregate: { mean: { avg: "score" }, total: { sum: "score" } },
      });
      const textOnly = rows.find((r) => r.team === "text-only");
      expect(textOnly).toBeDefined();
      expect(textOnly!.mean).toBeNull();
      expect(textOnly!.total).toBeNull();
    });

    it("group_by groups with counts, ordered by group key", async () => {
      const rows = await aggregated({ groupBy: "team", aggregate: { n: "count" } });
      expect(rows).toEqual([
        { team: "blue", n: 2 },
        { team: "red", n: 2 },
        { team: "text-only", n: 1 },
      ]);
    });

    it("time_bucket buckets by created_at", async () => {
      // Push two records into yesterday's bucket directly in the DB.
      const [coll] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
      await testDb.execute(sql`
        UPDATE records SET created_at = created_at - interval '1 day'
        WHERE collection_id = ${coll.id}
          AND id IN (SELECT id FROM records WHERE collection_id = ${coll.id} ORDER BY id ASC LIMIT 2)
      `);

      const rows = await aggregated({ timeBucket: "day", aggregate: { n: "count" } });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveProperty("time_bucket");
      expect(rows.map((r) => Number(r.n))).toEqual([2, 3]); // ordered by bucket ASC
    });
  });

  // ── d. sort, projection, pagination ───────────────────────────────────────

  describe("sort, projection, pagination", () => {
    it("sorts on a data field both directions", async () => {
      const slug = await seed("sorting", [{ name: "carol" }, { name: "alice" }, { name: "bob" }]);

      const ascResult = await query(slug, { sort: "name" });
      if (!("records" in ascResult)) throw new Error("expected records shape");
      expect(ascResult.records.map((r) => (r.data as Record<string, unknown>).name)).toEqual([
        "alice",
        "bob",
        "carol",
      ]);

      const descResult = await query(slug, { sort: "-name" });
      if (!("records" in descResult)) throw new Error("expected records shape");
      expect(descResult.records.map((r) => (r.data as Record<string, unknown>).name)).toEqual([
        "carol",
        "bob",
        "alice",
      ]);
    });

    it("fields projection keeps only requested top-level keys", async () => {
      const slug = await seed("projection", [{ title: "T", url: "u", body: "long text", extra: 1 }]);

      const result = await query(slug, { fields: ["title", "url"] });
      if (!("records" in result)) throw new Error("expected records shape");
      expect(result.records[0].data).toEqual({ title: "T", url: "u" });
    });

    it("pagination reports total / has_more / next_offset correctly", async () => {
      // Single-digit i values sort deterministically as text (data->>'i').
      const slug = await seed(
        "pagination",
        Array.from({ length: 5 }, (_, i) => ({ i: String(i) })),
      );

      const page1 = await query(slug, { limit: 2, offset: 0, sort: "i" });
      if (!("records" in page1)) throw new Error("expected records shape");
      expect(page1.count).toBe(2);
      expect(page1.total).toBe(5);
      expect(page1.has_more).toBe(true);
      expect(page1.next_offset).toBe(2);

      const page3 = await query(slug, { limit: 2, offset: 4, sort: "i" });
      if (!("records" in page3)) throw new Error("expected records shape");
      expect(page3.count).toBe(1);
      expect(page3.total).toBe(5);
      expect(page3.has_more).toBe(false);
      expect(page3.next_offset).toBeNull();
    });
  });

  // ── e. upsert via unique_key ──────────────────────────────────────────────

  describe("createRecords upsert with unique_key", () => {
    async function upsertCollection(name: string): Promise<string> {
      const created = ok(
        await collectionsSvc.createCollection(USER_ID, ORG_ID, { name, unique_key: ["sku"] }),
      );
      return created.collection.slug;
    }

    it("on_conflict replace (default) overwrites the matching record", async () => {
      const slug = await upsertCollection("Upsert Replace");
      await recordsSvc.createRecords(USER_ID, ORG_ID, {
        collection: "Upsert Replace",
        records: [{ sku: "a1", qty: 1, legacy: true }],
      });
      const second = ok(
        await recordsSvc.createRecords(USER_ID, ORG_ID, {
          collection: "Upsert Replace",
          records: [{ sku: "a1", qty: 2 }],
        }),
      ) as { results: { action: string }[] };
      expect(second.results[0].action).toBe("updated");

      const data = await rawData(slug);
      expect(data).toEqual([{ sku: "a1", qty: 2 }]); // legacy gone — full replace
    });

    it("on_conflict merge shallow-merges into the existing record", async () => {
      const slug = await upsertCollection("Upsert Merge");
      await recordsSvc.createRecords(USER_ID, ORG_ID, {
        collection: "Upsert Merge",
        records: [{ sku: "a1", qty: 1, keep: "yes" }],
      });
      const second = ok(
        await recordsSvc.createRecords(USER_ID, ORG_ID, {
          collection: "Upsert Merge",
          records: [{ sku: "a1", qty: 5 }],
          on_conflict: "merge",
        }),
      ) as { results: { action: string }[] };
      expect(second.results[0].action).toBe("updated");

      const data = await rawData(slug);
      expect(data).toEqual([{ sku: "a1", qty: 5, keep: "yes" }]);
    });

    it("on_conflict skip leaves the existing record untouched", async () => {
      const slug = await upsertCollection("Upsert Skip");
      await recordsSvc.createRecords(USER_ID, ORG_ID, {
        collection: "Upsert Skip",
        records: [{ sku: "a1", qty: 1 }],
      });
      const second = ok(
        await recordsSvc.createRecords(USER_ID, ORG_ID, {
          collection: "Upsert Skip",
          records: [{ sku: "a1", qty: 99 }],
          on_conflict: "skip",
        }),
      ) as { results: { action: string }[] };
      expect(second.results[0].action).toBe("skipped");

      const data = await rawData(slug);
      expect(data).toEqual([{ sku: "a1", qty: 1 }]);
    });

    it("on_conflict error returns 409 and inserts nothing", async () => {
      const slug = await upsertCollection("Upsert Error");
      await recordsSvc.createRecords(USER_ID, ORG_ID, {
        collection: "Upsert Error",
        records: [{ sku: "a1", qty: 1 }],
      });
      const second = await recordsSvc.createRecords(USER_ID, ORG_ID, {
        collection: "Upsert Error",
        records: [{ sku: "a1", qty: 2 }],
        on_conflict: "error",
      });
      expect(second).toMatchObject({ status: 409 });

      const data = await rawData(slug);
      expect(data).toEqual([{ sku: "a1", qty: 1 }]);
    });

    it("non-conflicting records still insert alongside upserts", async () => {
      const slug = await upsertCollection("Upsert Mixed");
      await recordsSvc.createRecords(USER_ID, ORG_ID, {
        collection: "Upsert Mixed",
        records: [{ sku: "a1", qty: 1 }],
      });
      const second = ok(
        await recordsSvc.createRecords(USER_ID, ORG_ID, {
          collection: "Upsert Mixed",
          records: [{ sku: "a1", qty: 2 }, { sku: "b2", qty: 7 }],
        }),
      ) as { results: { action: string }[] };
      expect(second.results.map((r) => r.action)).toEqual(["updated", "created"]);

      const data = await rawData(slug);
      expect(data).toEqual([
        { sku: "a1", qty: 2 },
        { sku: "b2", qty: 7 },
      ]);
    });
  });

  // ── f. export → import round trip ─────────────────────────────────────────

  it("exportRecords CSV round-trips through importRecords via the real DB", async () => {
    // Values chosen to survive CSV coercion: commas/quotes exercise RFC 4180
    // quoting; the nested object is JSON-stringified into its cell.
    const original = [
      { title: "Hello, world", note: 'She said "hi"', qty: 3, meta: { deep: true } },
      { title: "Second", qty: 1.5, flag: false },
    ];
    const sourceSlug = await seed("export_source", original);

    const exported = ok(await recordsSvc.exportRecords(sourceSlug, USER_ID, { format: "csv" }));
    expect(exported.format).toBe("csv");
    expect(exported.count).toBe(2);
    expect(exported.truncated).toBe(false);

    // importRecords' inferred return union re-exposes the raw createRecords
    // shape on the error path, so narrow the success shape explicitly.
    const imported = ok(
      await recordsSvc.importRecords(USER_ID, ORG_ID, {
        collection: "export_target",
        format: "csv",
        content: exported.content,
      }),
    ) as { collection: { name: string; slug: string }; count: number; created: number };
    expect(imported.count).toBe(2);
    expect(imported.created).toBe(2);

    const data = await rawData(imported.collection.slug);
    // CSV export orders newest-first (created_at DESC); compare as sets.
    expect(data).toHaveLength(2);
    expect(data).toEqual(expect.arrayContaining(original));
  });

  // ── g. stats + describe ───────────────────────────────────────────────────

  it("getCollectionStats runs its SQL and returns a sane shape", async () => {
    const slug = await seed("stats", [
      { a: 1, b: "x" },
      { a: 2 },
      { a: 3, b: "y", c: true },
    ]);

    const stats = ok(await collectionsSvc.getCollectionStats(slug, USER_ID));
    expect(stats.record_count).toBe(3);
    expect(stats.by_status).toEqual({ active: 3 });
    expect(stats.first_created_at).toBeTruthy();
    expect(stats.last_created_at).toBeTruthy();
    expect(stats.approx_storage_bytes).toBeGreaterThan(0);
    expect(stats.fields).toEqual([
      { name: "a", count: 3, percent: 100 },
      { name: "b", count: 2, percent: 66.7 },
      { name: "c", count: 1, percent: 33.3 },
    ]);
  });

  it("describeCollection samples real rows and reports fields", async () => {
    const slug = await seed("describe", [
      { title: "one", score: 10 },
      { title: "two", score: 20 },
    ]);

    const described = ok(await collectionsSvc.describeCollection(slug, USER_ID));
    expect(described.recordCount).toBe(2);
    const byName = new Map(described.fields.map((f) => [f.name, f]));
    expect(byName.get("title")?.frequency).toBe(1);
    const score = byName.get("score");
    expect(score?.min).toBe(10);
    expect(score?.max).toBe(20);
    expect(score?.avg).toBe(15);
  });

  // ── h. full-text search ───────────────────────────────────────────────────

  describe("full-text search", () => {
    it("queryRecords search param matches via tsvector", async () => {
      const slug = await seed("search_local", [
        { body: "the quick brown fox jumps" },
        { body: "an unrelated sentence" },
      ]);

      const hit = await query(slug, { search: "fox" });
      if (!("records" in hit)) throw new Error("expected records shape");
      expect(hit.total).toBe(1);
      expect((hit.records[0].data as Record<string, unknown>).body).toContain("fox");

      const miss = await query(slug, { search: "zeppelin" });
      if (!("records" in miss)) throw new Error("expected records shape");
      expect(miss.total).toBe(0);
    });

    it("searchGlobal finds matches across accessible collections", async () => {
      await seed("search_one", [{ text: "vintage synthesizer restoration" }]);
      await seed("search_two", [{ text: "synthesizer patch library" }, { text: "gardening tips" }]);

      const result = await recordsSvc.searchGlobal(USER_ID, "synthesizer");
      expect(result.results).toHaveLength(2);
      const totalMatches = result.results.reduce((n, g) => n + g.matches, 0);
      expect(totalMatches).toBe(2);

      const none = await recordsSvc.searchGlobal(USER_ID, "nonexistentterm");
      expect(none.results).toHaveLength(0);
    });
  });
});
