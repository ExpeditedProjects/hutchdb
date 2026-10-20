import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Per-collection storage against real Postgres: table
// creation, exact document round-trips, projection and unwind inference at
// low thresholds, index-backed filters, nested aggregates checked against an
// in-memory oracle, child-row resync, soft deletes and table drops.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set (see
// records.integration.test.ts for the wiring rationale).
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "storage-user";
const ORG_ID = "storage-org";
const THRESHOLD = 100;

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");

function ok<T>(result: T): Exclude<T, { error: unknown } | null | undefined> {
  if (result == null || (typeof result === "object" && "error" in (result as object))) {
    throw new Error(`Expected success result, got: ${JSON.stringify(result)}`);
  }
  return result as Exclude<T, { error: unknown } | null | undefined>;
}

type Vote = { category_id: number; points: number; label: string };
type Doc = { id: number; name: string; score: number; votes: Vote[] };

function makeDocs(n: number, votesPer: number): Doc[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `doc-${i}`,
    score: (i * 7) % 50,
    votes: Array.from({ length: votesPer }, (_, k) => ({
      category_id: (i + k) % 4,
      points: ((i * 3 + k * 5) % 11) + 1,
      label: `v${k}`,
    })),
  }));
}

describe.skipIf(!TEST_DB_URL)("collection tables against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    process.env.HUTCH_PROJECT_THRESHOLD = String(THRESHOLD);
    process.env.HUTCH_UNWIND_THRESHOLD = String(THRESHOLD);

    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });

    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    appPool = (await import("@/lib/db")).db.$client as Pool;

    await testDb.insert(schema.user).values({ id: USER_ID, email: "storage@hutch.test", name: "Storage" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "storage", name: "Storage", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    // Per-collection tables are not FK-linked to collections; drop leftovers.
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    // Integration files may share a worker process: leave the flag as found.
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  async function store(collection: string, recs: Record<string, unknown>[], on_conflict?: string) {
    return ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection, records: recs, on_conflict }));
  }

  async function collectionRow(slug: string) {
    const [row] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    return row;
  }

  async function registry(slug: string) {
    const { readRegistry } = await import("./registry");
    return readRegistry((await collectionRow(slug)).storage);
  }

  async function tableExists(name: string): Promise<boolean> {
    const r = await testDb.execute(sql`SELECT to_regclass(${name}) IS NOT NULL AS present`);
    return (r.rows[0] as { present: boolean }).present;
  }

  async function query(slug: string, params: Parameters<RecordsService["queryRecords"]>[2]) {
    return ok(await recordsSvc.queryRecords(slug, USER_ID, params)) as Record<string, unknown> & {
      records?: { id: number; data: unknown }[];
      results?: Record<string, unknown>[];
      total?: number;
      indexed: boolean;
      plan: string;
    };
  }

  it("creates hc_<id> on the first store and round-trips documents exactly", async () => {
    const docs = [
      { s: "hello", n: 1e21, numeric_string: "00123", nil: null, nested: { a: [1, { b: null }], c: "x" } },
      { s: "ünïcode ✓", n: -0.5, list: [{ k: "a" }, { k: "b", extra: [1, 2, 3] }], bool: false },
      { s: "it's \"quoted\" \\ backslash", n: 9007199254740993, empty: {}, emptyList: [] },
    ];
    const stored = await store("roundtrip", docs);
    const slug = (stored as { collection: { slug: string } }).collection.slug;
    const row = await collectionRow(slug);
    expect(await tableExists(`hc_${row.id}`)).toBe(true);

    const result = await query(slug, { limit: 10 });
    const back = result.records!.slice().sort((a, b) => a.id - b.id).map((r) => r.data);
    // 9007199254740993 is not representable in a JS double; it reads back
    // as the nearest double, exactly as JSON.parse would give it.
    expect(back).toEqual(JSON.parse(JSON.stringify(docs)));
    expect(result.total).toBe(3);
    expect(typeof result.indexed).toBe("boolean");
    expect(typeof result.plan).toBe("string");
  });

  it("projects declared scalar fields at the row threshold and serves filters from the index", async () => {
    const docs = Array.from({ length: 1500 }, (_, i) => ({ code: i, tag: `t${i % 10}`, flag: i % 2 === 0 }));
    const slug = (await store("projected", docs) as { collection: { slug: string } }).collection.slug;

    const reg = await registry(slug);
    expect(reg.projections.map((p) => [p.field, p.column, p.type])).toEqual([
      ["code", "p_code", "number"],
      ["flag", "p_flag", "boolean"],
      ["tag", "p_tag", "text"],
    ]);
    expect(reg.projections[0].reason).toMatch(/threshold 100/);
    expect(reg.evaluated_rows).toBe(1500);

    await testDb.execute(sql`ANALYZE ${sql.identifier(`hc_${(await collectionRow(slug)).id}`)}`);

    const byCode = await query(slug, { filter: { code: 1234 } });
    expect(byCode.records!.map((r) => (r.data as { code: number }).code)).toEqual([1234]);
    expect(byCode.indexed).toBe(true);
    expect(byCode.plan).toMatch(/^(Index Scan|Index Only Scan|Bitmap Index Scan) using hc_\d+_p_code_idx$/);

    const range = await query(slug, { filter: { code: { $gte: 10, $lt: 20 }, flag: true }, sort: "code", limit: 100 });
    expect(range.records!.map((r) => (r.data as { code: number }).code)).toEqual([10, 12, 14, 16, 18]);
    expect(range.indexed).toBe(true);

    // A second store after the threshold adds nothing and changes nothing.
    await store("projected", [{ code: 99999, tag: "late", flag: false }]);
    expect((await registry(slug)).projections).toHaveLength(3);
  });

  it("a mismatched-type literal on a projected field still matches through the JSON path", async () => {
    // 1% string outliers keep `code` declared as a number.
    const docs = Array.from({ length: 200 }, (_, i) => ({ code: i === 7 ? "7" : i }));
    const slug = (await store("mismatch", docs) as { collection: { slug: string } }).collection.slug;
    expect((await registry(slug)).projections.map((p) => p.field)).toEqual(["code"]);

    const asString = await query(slug, { filter: { code: "7" } });
    expect(asString.records!.map((r) => r.data)).toEqual([{ code: "7" }]);
    const asNumber = await query(slug, { filter: { code: 7 } });
    expect(asNumber.records).toHaveLength(0);
    const asNumber8 = await query(slug, { filter: { code: 8 } });
    expect(asNumber8.records!.map((r) => r.data)).toEqual([{ code: 8 }]);
  });

  describe("unwinds", () => {
    let slug: string;
    let docs: Doc[];
    let tableName: string;

    beforeEach(async () => {
      docs = makeDocs(60, 3); // 180 elements >= threshold (60 rows < project threshold)
      slug = (await store("votes_demo", docs) as { collection: { slug: string } }).collection.slug;
      tableName = `hc_${(await collectionRow(slug)).id}`;
      await testDb.execute(sql`ANALYZE ${sql.identifier(`${tableName}__votes`)}`);
    });

    it("creates the child table, projects the parent keys, and keeps documents intact", async () => {
      const reg = await registry(slug);
      expect(reg.unwinds).toHaveLength(1);
      expect(reg.unwinds[0].path).toBe("votes");
      expect(reg.unwinds[0].table).toBe(`${tableName}__votes`);
      expect(reg.unwinds[0].fields.map((f) => [f.field, f.type])).toEqual([
        ["category_id", "number"],
        ["label", "text"],
        ["points", "number"],
      ]);
      expect(reg.unwinds[0].reason).toMatch(/180 elements/);
      // Parent keys are projected even though 60 rows < PROJECT_THRESHOLD.
      expect(reg.projections.map((p) => p.field)).toEqual(["id", "name", "score"]);
      expect(reg.projections[0].reason).toMatch(/nested aggregates/);

      const childCount = await testDb.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(`${tableName}__votes`)}`);
      expect((childCount.rows[0] as { n: number }).n).toBe(180);

      const all = await query(slug, { limit: 100, sort: "id" });
      expect(all.records!.map((r) => r.data)).toEqual(docs);
    });

    it("filters on a dotted path through the child table with an index", async () => {
      const result = await query(slug, { filter: { "votes.category_id": 2, "votes.points": { $gte: 9 } }, limit: 100, sort: "id" });
      const expected = docs.filter((d) => d.votes.some((v) => v.category_id === 2 && v.points >= 9)).map((d) => d.id);
      expect(result.records!.map((r) => (r.data as Doc).id)).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
      // 180 child rows fit in two pages, so the planner may prefer a
      // sequential scan here; the index assertion lives in the larger
      // "serves nested filters from the child index" test below.
      expect(typeof result.indexed).toBe("boolean");
      expect(result.plan).toMatch(/hc_\d+/);
      if (!result.indexed) expect(result.reason).toMatch(/filter on votes.category_id/);
    });

    it("serves nested filters and aggregates from the child indexes once the tables have some size", async () => {
      const big = makeDocs(3000, 4); // 12,000 child rows
      const s2 = (await store("votes_big", big) as { collection: { slug: string } }).collection.slug;
      const t2 = `hc_${(await collectionRow(s2)).id}`;
      expect((await registry(s2)).unwinds).toHaveLength(1);
      await testDb.execute(sql`ANALYZE ${sql.identifier(t2)}`);
      await testDb.execute(sql`ANALYZE ${sql.identifier(`${t2}__votes`)}`);

      const filtered = await query(s2, { filter: { "votes.category_id": 2, "votes.points": 11 }, limit: 1000, sort: "id" });
      expect(filtered.records!.map((r) => (r.data as Doc).id)).toEqual(
        big.filter((d) => d.votes.some((v) => v.category_id === 2 && v.points === 11)).map((d) => d.id),
      );
      expect(filtered.indexed).toBe(true);
      expect(filtered.plan).toMatch(/^(Index Scan|Index Only Scan|Bitmap Index Scan) using hc_\d+/);

      const agg = await query(s2, {
        filter: { "votes.points": 11, id: { $lt: 100 } },
        groupBy: "votes.category_id",
        aggregate: { pts: { sum: "votes.points" } },
        limit: 1000,
        perRecord: true,
      });
      const oracle = big.filter((d) => d.id < 100).flatMap((d) => {
        const by = new Map<number, number>();
        for (const v of d.votes) if (v.points === 11) by.set(v.category_id, (by.get(v.category_id) ?? 0) + v.points);
        return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([category, pts]) => ({ id: d.id, category, pts }));
      });
      expect(oracle.length).toBeGreaterThan(0);
      expect(agg.results!.map((r) => ({ id: (r.record as { data: Doc }).data.id, category: r["votes.category_id"], pts: r.pts }))).toEqual(oracle);
      expect(agg.indexed).toBe(true);
    });

    it("aggregates over the child table per parent and matches an in-memory oracle", async () => {
      const result = await query(slug, {
        filter: { "votes.category_id": 1, score: { $gte: 10 } },
        groupBy: "votes.category_id",
        aggregate: { pts: { sum: "votes.points" }, n: "count", best: { max: "votes.points" } },
        limit: 1000,
        perRecord: true,
      });

      const oracle = docs
        .filter((d) => d.score >= 10)
        .map((d) => {
          const hits = d.votes.filter((v) => v.category_id === 1);
          return { id: d.id, pts: hits.reduce((s, v) => s + v.points, 0), n: hits.length, best: Math.max(...hits.map((v) => v.points)) };
        })
        .filter((r) => r.n > 0);
      expect(oracle.length).toBeGreaterThan(0);

      const rows = result.results!.map((r) => ({
        id: (r.record as { data: Doc }).data.id,
        pts: r.pts,
        n: r.n,
        best: r.best,
        category: r["votes.category_id"],
      }));
      expect(rows.map(({ category }) => category)).toEqual(oracle.map(() => 1));
      expect(rows.map(({ id, pts, n, best }) => ({ id, pts, n, best }))).toEqual(oracle);
      // The attached parent record has the unwound array removed.
      expect((result.results![0].record as { data: Doc }).data.votes).toBeUndefined();
      expect(typeof result.results![0].pts).toBe("number");
      expect(typeof result.indexed).toBe("boolean");
    });

    it("the same nested query works before any unwind exists (jsonpath + lateral fallback)", async () => {
      const small = makeDocs(5, 2); // 10 elements < threshold
      const s2 = (await store("votes_small", small) as { collection: { slug: string } }).collection.slug;
      expect((await registry(s2)).unwinds).toEqual([]);

      const filtered = await query(s2, { filter: { "votes.category_id": 1 }, sort: "id" });
      expect(filtered.records!.map((r) => (r.data as Doc).id)).toEqual(
        small.filter((d) => d.votes.some((v) => v.category_id === 1)).map((d) => d.id),
      );

      const agg = await query(s2, { groupBy: "votes.category_id", aggregate: { pts: { sum: "votes.points" } }, perRecord: true });
      const oracle = small.flatMap((d) => {
        const by = new Map<number, number>();
        for (const v of d.votes) by.set(v.category_id, (by.get(v.category_id) ?? 0) + v.points);
        return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([category, pts]) => ({ id: d.id, category, pts }));
      });
      expect(agg.results!.map((r) => ({ id: (r.record as { data: Doc }).data.id, category: r["votes.category_id"], pts: r.pts }))).toEqual(oracle);
    });

    it("resyncs child rows when a parent document is updated", async () => {
      const first = (await query(slug, { filter: { id: 3 } })).records![0];
      const updated = { ...(first.data as Doc), votes: [{ category_id: 9, points: 100, label: "new" }] };
      ok(await recordsSvc.updateRecord(slug, USER_ID, first.id, updated));

      const rows = await testDb.execute(
        sql`SELECT idx, p_category_id, p_points, p_label FROM ${sql.identifier(`${tableName}__votes`)} WHERE parent_id = ${first.id} ORDER BY idx`,
      );
      expect(rows.rows).toEqual([{ idx: 1, p_category_id: 9, p_points: 100, p_label: "new" }]);

      const hit = await query(slug, { filter: { "votes.category_id": 9 } });
      expect(hit.records!.map((r) => r.id)).toEqual([first.id]);
      expect(hit.records![0].data).toEqual(updated);

      // A status change does not touch data and leaves the child rows alone.
      ok(await recordsSvc.updateRecordStatus(slug, USER_ID, first.id, "flagged"));
      const again = await testDb.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(`${tableName}__votes`)} WHERE parent_id = ${first.id}`);
      expect((again.rows[0] as { n: number }).n).toBe(1);
    });

    it("removes a deleted record from plain, nested and aggregate results", async () => {
      const victim = (await query(slug, { filter: { id: 10 } })).records![0];
      ok(await recordsSvc.deleteRecord(slug, USER_ID, victim.id));

      expect((await query(slug, { filter: { id: 10 } })).records).toHaveLength(0);
      const category = docs[10].votes[0].category_id;
      const nested = await query(slug, { filter: { "votes.category_id": category }, limit: 100 });
      expect(nested.records!.map((r) => r.id)).not.toContain(victim.id);
      const agg = await query(slug, { groupBy: "votes.category_id", aggregate: { n: "count" }, limit: 1000, perRecord: true });
      expect(agg.results!.map((r) => r.parent_id)).not.toContain(victim.id);
      expect((await collectionsSvc.describeCollection(slug, USER_ID))!.recordCount).toBe(59);
    });

    it("describe reports storage and deleting the collection drops its tables", async () => {
      const described = (await collectionsSvc.describeCollection(slug, USER_ID)) as Record<string, unknown>;
      const storage = described.storage as { projections: { field: string }[]; unwinds: { path: string; rows: number; reason: string }[] };
      expect(storage.projections.map((p) => p.field)).toEqual(["id", "name", "score"]);
      expect(storage.unwinds[0]).toMatchObject({ path: "votes", rows: 180 });

      ok(await collectionsSvc.deleteCollection(slug, USER_ID));
      expect(await tableExists(tableName)).toBe(false);
      expect(await tableExists(`${tableName}__votes`)).toBe(false);
      expect(await collectionRow(slug)).toBeUndefined();
    });
  });

  describe("sorting, deeper paths, multi-key group_by and slim records", () => {
    type Leg = { name: string; party: string; totals: { veterans: { points: number; votes: number } }; votes: { category_id: number; label: string; points: { veterans: number } }[] };
    let slug: string;
    let legs: Leg[];

    beforeEach(async () => {
      legs = Array.from({ length: 60 }, (_, i) => ({
        name: `L${String(i).padStart(2, "0")}`,
        party: i % 2 ? "D" : "R",
        totals: { veterans: { points: (i * 13) % 31, votes: i % 5 } },
        votes: Array.from({ length: 3 }, (_, k) => ({ category_id: (i + k) % 4, label: `v${k}`, points: { veterans: (i + 2 * k) % 3 } })),
      }));
      slug = (await store("legislators_like", legs) as { collection: { slug: string } }).collection.slug;
      const reg = await registry(slug);
      expect(reg.unwinds[0].fields.map((f) => f.field)).toEqual(["category_id", "label"]); // points is an object: no column
    });

    it("sorts records on a dotted object path numerically and reports whether an index served it", async () => {
      const result = await query(slug, { sort: "-totals.veterans.points", fields: ["name", "totals"], limit: 10 });
      const expected = legs.slice().sort((a, b) => b.totals.veterans.points - a.totals.veterans.points || a.name.localeCompare(b.name)).slice(0, 10);
      const got = result.records!.map((r) => (r.data as Leg).totals.veterans.points);
      expect(got).toEqual(expected.map((d) => d.totals.veterans.points));
      // totals.veterans.points is now projected (nested scalar paths are), so
      // whether its index serves the sort is the planner's call on 60 rows.
      expect((await registry(slug)).projections.map((p) => p.field)).toContain("totals.veterans.points");
      if (result.indexed) expect(result.plan).toMatch(/p_totals_veterans_points_idx/);
      else expect(result.reason).toMatch(/No index served sort on totals.veterans.points/);
      expect(result.total).toBe(60);
    });

    it("refuses sort fields that would otherwise fall back silently", async () => {
      await expect(query(slug, { sort: "-totals.veterans.pointz" })).rejects.toThrow(/Invalid sort field 'totals.veterans.pointz': no record in this collection has it/);
      await expect(query(slug, { sort: "-nope" })).rejects.toThrow(/Invalid sort field 'nope'/);
      await expect(query(slug, { sort: "-votes.points" })).rejects.toThrow(/'votes' is an array of objects/);
      await expect(query(slug, { sort: "-points", groupBy: "votes.category_id", aggregate: { n: "count" } })).rejects.toThrow(/aggregate alias or a group_by key here \(votes.category_id, n\)/);
      await expect(query(slug, { sort: "-votes.category_id", aggregate: { n: "count" } })).rejects.toThrow(/Invalid sort field 'votes.category_id' for an aggregate query/);
    });

    it("sorts aggregate rows by alias, limits after ordering, and reports the group total", async () => {
      const result = await query(slug, {
        filter: { "votes.category_id": 1 },
        groupBy: "votes.category_id",
        aggregate: { pts: { sum: "votes.points.veterans" }, n: "count" },
        sort: "-pts",
        limit: 5,
        perRecord: true,
      });
      const oracle = legs
        .map((d, id) => ({ id: id + 1, hits: d.votes.filter((v) => v.category_id === 1) }))
        .filter((r) => r.hits.length > 0)
        .map((r) => ({ id: r.id, pts: r.hits.reduce((s, v) => s + v.points.veterans, 0), n: r.hits.length }))
        .sort((a, b) => b.pts - a.pts || a.id - b.id);
      expect(result.results!.length).toBe(5);
      expect(result.total).toBe(oracle.length);
      expect(result.results!.map((r) => r.pts)).toEqual(oracle.slice(0, 5).map((r) => r.pts));
      expect(result.results![0].pts).toBe(oracle[0].pts);
      // The attached record carries only top-level scalars by default.
      const rec = result.results![0].record as { data: Record<string, unknown> };
      expect(Object.keys(rec.data).sort()).toEqual(["name", "party"]);
    });

    it("applies fields to the embedded record and record: false omits it", async () => {
      const withFields = await query(slug, { groupBy: "votes.category_id", aggregate: { n: "count" }, fields: ["name", "totals"], limit: 3, perRecord: true });
      const rec = withFields.results![0].record as { data: Record<string, unknown> };
      expect(Object.keys(rec.data).sort()).toEqual(["name", "totals"]);
      expect((rec.data.totals as Leg["totals"]).veterans).toBeDefined();

      const without = await query(slug, { groupBy: "votes.category_id", aggregate: { n: "count" }, record: false, limit: 3, perRecord: true });
      expect(without.results![0]).not.toHaveProperty("record");
      expect(without.results![0]).toHaveProperty("parent_id");
    });

    it("filters and aggregates on a path below the array element through the document", async () => {
      const filtered = await query(slug, { filter: { "votes.points.veterans": { $gte: 2 } }, limit: 100, sort: "name" });
      const expectedNames = legs.filter((d) => d.votes.some((v) => v.points.veterans >= 2)).map((d) => d.name);
      expect(filtered.records!.map((r) => (r.data as Leg).name)).toEqual(expectedNames);
      expect(filtered.indexed).toBe(false);
      expect(filtered.reason).toMatch(/filter on votes.points.veterans \(\$gte\)/);

      const agg = await query(slug, { groupBy: "votes.category_id", aggregate: { v: { sum: "votes.points.veterans" } }, limit: 1000, record: false, perRecord: true });
      const oracle = legs.flatMap((d, id) => {
        const by = new Map<number, number>();
        for (const v of d.votes) by.set(v.category_id, (by.get(v.category_id) ?? 0) + v.points.veterans);
        return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([category, v]) => ({ parent_id: id + 1, "votes.category_id": category, v }));
      });
      expect(agg.results).toEqual(oracle);
      expect(agg.total).toBe(oracle.length);
    });

    it("groups by several keys named after the keys", async () => {
      const agg = await query(slug, { groupBy: ["votes.category_id", "votes.label"], aggregate: { n: "count" }, filter: { party: "D" }, limit: 1000, record: false, perRecord: true });
      const oracle = legs.flatMap((d, id) => {
        if (d.party !== "D") return [];
        return d.votes
          .map((v) => ({ parent_id: id + 1, "votes.category_id": v.category_id, "votes.label": v.label, n: 1 }))
          .sort((a, b) => a["votes.category_id"] - b["votes.category_id"] || a["votes.label"].localeCompare(b["votes.label"]));
      });
      expect(agg.results).toEqual(oracle);

      const mixed = await query(slug, { groupBy: ["party", "votes.label"], aggregate: { n: "count" }, limit: 1000, record: false, perRecord: true });
      expect(mixed.results![0]).toMatchObject({ parent_id: 1, party: "R", "votes.label": "v0", n: 1 });
      await expect(query(slug, { groupBy: ["a", "b", "c", "d", "e", "f"] })).rejects.toThrow(/at most 5 keys/);
    });

    it("counts only indexes that serve a clause the caller wrote", async () => {
      const plain = await query(slug, { limit: 5 });
      expect(plain.indexed).toBe(false);
      expect(plain.reason).toMatch(/no filter, search or sort/);

      // `id` is the document field: these documents have none.
      expect((await query(slug, { filter: { id: 1 } })).records).toHaveLength(0);

      const recent = await query(slug, { sort: "-created_at", limit: 5 });
      if (recent.indexed) expect(recent.plan).toMatch(/using hc_\d+_created_at_idx/);
      else expect(recent.reason).toMatch(/sort on created_at/);
    });
  });

  it("honors unique_key upserts with replace, skip, error and merge", async () => {
    const slug = (await store("upsert", [{ key: "a", v: 1 }]) as { collection: { slug: string } }).collection.slug;
    ok(await collectionsSvc.updateCollection(slug, USER_ID, { unique_key: ["key"] }));

    const replaced = await store("upsert", [{ key: "a", v: 2 }, { key: "b", v: 1 }, { v: 0 }], "replace");
    expect((replaced as { results: { action: string }[] }).results.map((r) => r.action)).toEqual(["updated", "created", "created"]);

    const skipped = await store("upsert", [{ key: "a", v: 3 }, { key: "c", v: 1 }], "skip");
    expect((skipped as { results: { action: string }[] }).results.map((r) => r.action).sort()).toEqual(["created", "skipped"]);

    const errored = await recordsSvc.createRecords(USER_ID, ORG_ID, { collection: "upsert", records: [{ key: "a", v: 4 }], on_conflict: "error" });
    expect(errored).toMatchObject({ status: 409 });

    // merge is {...existing, ...incoming}, also within one batch.
    const merged = await store("upsert", [{ key: "a", extra: true }, { key: "d", v: 1 }, { key: "d", w: 2 }], "merge");
    expect((merged as { results: { action: string }[] }).results.map((r) => r.action)).toEqual(["updated", "created"]);

    // Sorting on a data field puts records missing it last.
    const all = await query(slug, { sort: "key", limit: 10 });
    expect(all.records!.map((r) => r.data)).toEqual([{ key: "a", v: 2, extra: true }, { key: "b", v: 1 }, { key: "c", v: 1 }, { key: "d", v: 1, w: 2 }, { v: 0 }]);
  });

  it("transform, export, stats and truncate work on a collection table", async () => {
    const slug = (await store("misc", [{ a: 1, b: "x" }, { a: 2 }]) as { collection: { slug: string } }).collection.slug;

    const renamed = ok(await recordsSvc.transformRecords(slug, USER_ID, { rename_fields: { a: "n" } }));
    expect(renamed.updated).toBe(2);
    const exported = ok(await recordsSvc.exportRecords(slug, USER_ID, { format: "csv" }));
    expect(exported.content.split(/\r?\n/)[0].split(",")).toContain("n");

    const stats = ok(await collectionsSvc.getCollectionStats(slug, USER_ID));
    expect(stats.record_count).toBe(2);
    expect(stats.fields.map((f) => f.name)).toEqual(["n", "b"]);

    ok(await recordsSvc.truncateRecords(slug, USER_ID));
    expect((await query(slug, {})).total).toBe(0);
  });
});
