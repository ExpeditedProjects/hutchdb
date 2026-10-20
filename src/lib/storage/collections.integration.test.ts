import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Per-collection storage against real Postgres:
// - projecting nested object paths never changes a result: the same queries
//   over a projected collection and an unprojected one return the same rows,
//   sums and groups;
// - the sticky `mixed` flag that keeps sorts on the document;
// - the map rule on dollarvote-shaped documents;
// - several collections side by side: counts, listing, search, describe,
//   delete.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "collections-user";
const ORG_ID = "collections-org";

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");
type QueryParams = Parameters<RecordsService["queryRecords"]>[2];
type QueryResult = Record<string, unknown> & {
  records?: { id: number; data: unknown }[];
  results?: Record<string, unknown>[];
  total?: number;
  indexed?: boolean;
  plan?: string;
  reason?: string;
};

function ok<T>(result: T): Exclude<T, { error: unknown } | null | undefined> {
  if (result == null || (typeof result === "object" && "error" in (result as object))) {
    throw new Error(`Expected success result, got: ${JSON.stringify(result)}`);
  }
  return result as Exclude<T, { error: unknown } | null | undefined>;
}

describe.skipIf(!TEST_DB_URL)("per-collection storage against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  /** Set the inference thresholds for the writes that follow. */
  function useThreshold(threshold = 100) {
    process.env.HUTCH_PROJECT_THRESHOLD = String(threshold);
    process.env.HUTCH_UNWIND_THRESHOLD = String(threshold);
  }

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });

    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    appPool = (await import("@/lib/db")).db.$client as Pool;

    await testDb.insert(schema.user).values({ id: USER_ID, email: "collections@hutch.test", name: "Collections" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "collections-org", name: "Collections", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    useThreshold();
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  async function store(collection: string, recs: Record<string, unknown>[]): Promise<string> {
    const result = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection, records: recs, return: "summary" }));
    return (result as { collection: { slug: string } }).collection.slug;
  }

  async function collectionRow(slug: string) {
    const [row] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    return row;
  }

  async function registry(slug: string) {
    const { readRegistry } = await import("./registry");
    return readRegistry((await collectionRow(slug)).storage);
  }

  async function analyze(slug: string) {
    await testDb.execute(sql`ANALYZE ${sql.identifier(`hc_${(await collectionRow(slug)).id}`)}`);
  }

  async function query(slug: string, params: QueryParams): Promise<QueryResult> {
    return ok(await recordsSvc.queryRecords(slug, USER_ID, params)) as QueryResult;
  }

  /** What must not depend on projection: rows in order, totals, aggregate rows. */
  function answer(r: QueryResult) {
    return r.records ? { total: r.total, data: r.records.map((x) => x.data) } : { total: r.total, results: r.results };
  }

  describe("projecting nested object paths never changes the result", () => {
    const LABELS = ["alpha", "Bravo", "charlie", "Delta", "echo", "foxtrot", "Golf"];
    const docs = Array.from({ length: 2000 }, (_, i) => ({
      name: `n${String(i).padStart(4, "0")}`,
      grp: ["a", "b", "c"][i % 3],
      stats: {
        // Decimals whose float8 sum differs from the exact sum.
        score: i % 2 ? (i % 97) / 10 : i % 50,
        views: i * 3,
        label: LABELS[i % 7],
        ok: i % 4 === 0,
        when: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      },
      // 4% of documents have no totals at all.
      ...(i % 25 === 0 ? {} : { totals: { veterans: { points: ((i * 13) % 31) + (i % 3) / 10, votes: i % 5 } } }),
    }));

    const QUERIES: [string, QueryParams][] = [
      ["eq", { filter: { "totals.veterans.points": 5 }, limit: 1000 }],
      ["range + sort desc", { filter: { "totals.veterans.points": { $gte: 10.1, $lt: 20 } }, sort: "-totals.veterans.points", limit: 1000 }],
      ["$in + text sort", { filter: { "stats.label": { $in: ["Bravo", "echo"] } }, sort: "stats.label", limit: 1000 }],
      ["text range (collation)", { filter: { "stats.label": { $gt: "charlie" } }, limit: 1000 }],
      ["boolean", { filter: { "stats.ok": true }, limit: 1000 }],
      ["$nin", { filter: { "totals.veterans.votes": { $nin: [1, 2] } }, limit: 1000 }],
      ["$ne counts absent", { filter: { "totals.veterans.points": { $ne: 5 } }, limit: 10 }],
      ["date range", { filter: { "stats.when": { $gte: "2026-03-15", $lt: "2026-06-01" } }, limit: 1000 }],
      ["$exists false", { filter: { "totals.veterans.points": { $exists: false } }, limit: 1000 }],
      ["sort asc, absent last", { sort: "totals.veterans.points", limit: 1000 }],
      ["sort desc decimals", { sort: "-stats.score", limit: 300 }],
      // Descending projected sorts run as two parts (rows with a value, then
      // without): pages that straddle and pass the boundary at 1920 rows.
      ["sort desc, page straddles absent", { sort: "-totals.veterans.points", limit: 50, offset: 1900 }],
      ["sort desc, page after values", { sort: "-totals.veterans.points", limit: 50, offset: 1950 }],
      ["sort desc, page at the boundary", { sort: "-totals.veterans.points", limit: 20, offset: 1920 }],
      ["sort desc, page past the end", { sort: "-totals.veterans.points", limit: 50, offset: 2100 }],
      ["filtered sort desc, straddles", { filter: { "stats.label": "echo" }, sort: "-totals.veterans.points", limit: 40, offset: 260 }],
      ["date sort", { sort: "-stats.when", limit: 100 }],
      ["group sums", { groupBy: "grp", aggregate: { pts: { sum: "totals.veterans.points" }, avg: { avg: "stats.score" }, lo: { min: "totals.veterans.points" }, hi: { max: "stats.score" }, n: "count" } }],
      ["group by nested, top-N", { groupBy: "stats.label", aggregate: { s: { sum: "stats.score" } }, sort: "-s", limit: 3 }],
      ["filtered sum", { filter: { "stats.ok": false, "totals.veterans.votes": 3 }, aggregate: { s: { sum: "stats.score" }, p: { sum: "totals.veterans.points" } } }],
    ];

    it("projected and unprojected collections answer every query the same", async () => {
      useThreshold(100);
      const projected = await store("projected", docs);
      useThreshold(1_000_000_000);
      const plain = await store("unprojected", docs);

      expect((await registry(plain)).projections).toEqual([]);
      const reg = await registry(projected);
      expect(reg.projections.map((p) => p.field)).toEqual([
        "grp", "name",
        "stats.label", "stats.ok", "stats.score", "stats.views", "stats.when",
        "totals.veterans.points", "totals.veterans.votes",
      ]);
      expect(reg.projections.find((p) => p.field === "totals.veterans.points")).toMatchObject({
        path: ["totals", "veterans", "points"], column: "p_totals_veterans_points", type: "number",
      });
      expect(reg.projections.find((p) => p.field === "stats.when")?.type).toBe("date");
      expect(reg.projections.some((p) => p.mixed)).toBe(false);
      await analyze(projected);
      await analyze(plain);

      for (const [name, params] of QUERIES) {
        const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
        expect(answer(a), `${name}: projected vs unprojected`).toEqual(answer(b));
      }

      // The decimal sums are exact, not float8-accumulated.
      const sums = await query(projected, { aggregate: { s: { sum: "stats.score" } } });
      const exact = docs.reduce((acc, d) => acc + Math.round(d.stats.score * 10), 0) / 10;
      expect(sums.results![0].s).toBe(exact);

      const byPoints = await query(projected, { filter: { "totals.veterans.points": 5 } });
      expect(byPoints.indexed).toBe(true);
      expect(byPoints.plan).toMatch(/using hc_\d+_p_totals_veterans_points_idx$/);
      const unindexed = await query(plain, { sort: "-totals.veterans.points", limit: 10 });
      expect(unindexed.indexed).toBe(false);
      expect(unindexed.reason).toMatch(/'totals.veterans.points' is a nested object path with no projection/);
    }, 30_000); // two 2,000-document stores plus 44 queries; 5 s is too tight on a loaded machine
  });

  it("a descending sort on a nested projection is served by its index, rows without a value last", async () => {
    // Large enough that the planner prefers the index over a top-N sort.
    useThreshold(100);
    const docs = Array.from({ length: 12000 }, (_, i) => (i % 40 === 0 ? { k: i } : { k: i, totals: { veterans: { points: (i * 7919) % 10007 } } }));
    let slug = "";
    for (let i = 0; i < docs.length; i += 1000) slug = await store("big_points", docs.slice(i, i + 1000));
    expect((await registry(slug)).projections.map((p) => p.field)).toContain("totals.veterans.points");
    await analyze(slug);

    const top = await query(slug, { sort: "-totals.veterans.points", limit: 10 });
    expect(top.indexed, `${top.plan} / ${top.reason}`).toBe(true);
    expect(top.plan).toMatch(/hc_\d+_p_totals_veterans_points_idx/);
    const withPoints = docs.filter((d) => "totals" in d) as { k: number; totals: { veterans: { points: number } } }[];
    const expected = withPoints.slice().sort((a, b) => b.totals.veterans.points - a.totals.veterans.points || a.k - b.k);
    expect(top.records!.map((r) => r.data)).toEqual(expected.slice(0, 10));

    // The last page ends with the documents that have no totals, in insertion order.
    const last = await query(slug, { sort: "-totals.veterans.points", limit: 10, offset: 11995 });
    expect(last.records!.map((r) => (r.data as { k: number }).k)).toEqual([11800, 11840, 11880, 11920, 11960]);
    expect(last.total).toBe(12000);
  });

  describe("mixed value types keep sorts on the document", () => {
    it("a projection created over mixed values is flagged and sorts like the document", async () => {
      // 2 strings and a JSON null among 300: still declared a number (> 95%).
      const docs = Array.from({ length: 300 }, (_, i) => ({ k: i, m: { v: i === 10 || i === 20 ? `s${i}` : i === 30 ? null : (i * 7) % 101 } }));
      useThreshold(100);
      const projected = await store("mixed_projected", docs);
      useThreshold(1_000_000_000);
      const plain = await store("mixed_plain", docs);
      const p = (await registry(projected)).projections.find((x) => x.field === "m.v");
      expect(p).toMatchObject({ type: "number", mixed: true });
      await analyze(projected);

      for (const sort of ["m.v", "-m.v"]) {
        const [a, b] = await Promise.all([query(projected, { sort, limit: 1000 }), query(plain, { sort, limit: 1000 })]);
        expect(answer(a)).toEqual(answer(b));
        expect(a.indexed).toBe(false);
        expect(a.reason).toMatch(/'m.v' holds values of more than one type/);
      }
      // Filters stay on the column and stay exact.
      const [fa, fb] = await Promise.all([query(projected, { filter: { "m.v": { $gte: 50 } }, limit: 1000 }), query(plain, { filter: { "m.v": { $gte: 50 } }, limit: 1000 })]);
      expect(answer(fa)).toEqual(answer(fb));
    });

    it("a later store or update with another type flips the flag", async () => {
      useThreshold(100);
      const docs = Array.from({ length: 200 }, (_, i) => ({ k: i, m: { v: i } }));
      const slug = await store("flips", docs);
      expect((await registry(slug)).projections.find((x) => x.field === "m.v")?.mixed).toBeUndefined();
      expect((await query(slug, { sort: "-m.v", limit: 1 })).records![0].data).toEqual({ k: 199, m: { v: 199 } });

      await store("flips", [{ k: 200, m: { v: "late" } }]);
      expect((await registry(slug)).projections.find((x) => x.field === "m.v")?.mixed).toBe(true);
      // jsonb ranks numbers above strings, so a descending sort on the
      // document puts the string after every number.
      const desc = await query(slug, { sort: "-m.v", limit: 300 });
      expect(desc.records!.at(-1)!.data).toEqual({ k: 200, m: { v: "late" } });

      const other = await store("flips_update", docs);
      const first = (await query(other, { filter: { k: 0 } })).records![0];
      ok(await recordsSvc.updateRecord(other, USER_ID, first.id, { k: 0, m: { v: null } }));
      expect((await registry(other)).projections.find((x) => x.field === "m.v")?.mixed).toBe(true);
      const asc = await query(other, { sort: "m.v", limit: 1 });
      // JSON null is the lowest jsonb value, so it leads an ascending sort.
      expect(asc.records![0].data).toEqual({ k: 0, m: { v: null } });
    });
  });

  it("dollarvote-shaped legislators: the per-category totals map is not projected and still sorts correctly", async () => {
    const CATS = Array.from({ length: 24 }, (_, k) => `cat_${String(k).padStart(2, "0")}`);
    const legs = Array.from({ length: 120 }, (_, i) => ({
      bioguide_id: `B${String(i).padStart(3, "0")}`,
      name: `N${i}`,
      party: i % 2 ? "D" : "R",
      totals: Object.fromEntries(CATS.map((c, k) => [c, { points: (i * (k + 3)) % 29, possible: 29, votes: 24 }])),
      votes: [{ bill_id: "HR1", vote: "yea" }, { bill_id: "HR2", vote: "nay" }],
    }));
    useThreshold(100);
    const slug = await store("legislators", legs);
    const reg = await registry(slug);
    expect(reg.unwinds.map((u) => u.path)).toEqual(["votes"]);
    expect(reg.projections.map((p) => p.field)).toEqual(["bioguide_id", "name", "party"]);

    const result = await query(slug, { sort: "-totals.cat_05.points", fields: ["bioguide_id", "totals"], limit: 10 });
    const expected = legs.slice()
      .sort((a, b) => b.totals.cat_05.points - a.totals.cat_05.points || legs.indexOf(a) - legs.indexOf(b))
      .slice(0, 10).map((l) => l.bioguide_id);
    expect(result.records!.map((r) => (r.data as { bioguide_id: string }).bioguide_id)).toEqual(expected);
    expect(result.indexed).toBe(false);
    expect(result.reason).toMatch(/'totals.cat_05.points' is a nested object path with no projection/);
  });

  describe("several collections in one database", () => {
    it("each keeps its rows in its own table; counts, listing, search, describe and delete see them", async () => {
      const alpha = await store("alpha", [{ title: "zebra crossing", n: 1 }, { title: "plain", n: 2 }]);
      const beta = await store("beta", [{ title: "zebra stripes", n: 1 }, { title: "plain", n: 2 }]);
      await store("alpha", [{ title: "third", n: 3 }]);
      await store("beta", [{ title: "third", n: 3 }]);
      const betaRow = await collectionRow(beta);
      const hc = await testDb.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(`hc_${betaRow.id}`)}`);
      expect((hc.rows[0] as { n: number }).n).toBe(3);

      // Same data, same answers.
      const params: QueryParams = { filter: { n: { $gte: 2 } }, sort: "-n" };
      const [qa, qb] = await Promise.all([query(alpha, params), query(beta, params)]);
      expect(answer(qa)).toEqual(answer(qb));
      expect(qb).toHaveProperty("indexed");
      const ab = await query(beta, { groupBy: "title", aggregate: { n: "count" } });
      expect(answer(ab)).toEqual({ total: 3, results: [{ title: "plain", n: 1 }, { title: "third", n: 1 }, { title: "zebra stripes", n: 1 }] });

      const listed = await collectionsSvc.listCollections(USER_ID, ORG_ID);
      const bySlug = Object.fromEntries(listed.map((c) => [c.slug, c]));
      expect(bySlug[alpha].recordCount).toBe(3);
      expect(bySlug[beta].recordCount).toBe(3);
      expect(bySlug[beta].fields).toEqual(["n", "title"]);

      // Every listing that counts records counts the collection tables.
      const dashboard = await collectionsSvc.listCollectionsForDashboard(USER_ID, ORG_ID);
      expect(Object.fromEntries(dashboard.map((c) => [c.slug, c.recordCount]))).toEqual({ [alpha]: 3, [beta]: 3 });
      const recent = await collectionsSvc.listRecentCollectionsAcrossOrgs(USER_ID, 10);
      expect(Object.fromEntries(recent.map((c) => [c.slug, c.recordCount]))).toEqual({ [alpha]: 3, [beta]: 3 });
      expect(recent.every((c) => typeof c.lastRecordAt === "string")).toBe(true);
      ok(await recordsSvc.deleteRecord(alpha, USER_ID, (await query(alpha, { filter: { n: 3 } })).records![0].id));
      expect(ok(await collectionsSvc.getCollection(alpha, USER_ID)).recordCount).toBe(2);
      expect((await collectionsSvc.listCollectionsForDashboard(USER_ID, ORG_ID)).find((c) => c.slug === alpha)?.recordCount).toBe(2);

      const found = await recordsSvc.searchGlobal(USER_ID, "zebra");
      expect(found.results.map((r) => r.collection.slug).sort()).toEqual([alpha, beta].sort());

      const describedBeta = ok(await collectionsSvc.describeCollection(beta, USER_ID));
      expect(describedBeta).toMatchObject({ recordCount: 3, storage: { projections: [], unwinds: [] } });

      ok(await collectionsSvc.deleteCollection(beta, USER_ID));
      const gone = await testDb.execute(sql`SELECT to_regclass(${`hc_${betaRow.id}`}) IS NULL AS gone`);
      expect((gone.rows[0] as { gone: boolean }).gone).toBe(true);
    });

    it("listCollections samples each collection's fields concurrently but keeps the most-recently-updated-first order", async () => {
      const slugs: string[] = [];
      for (let c = 0; c < 7; c++) slugs.push(await store(`many_${c}`, [{ [`f${c}`]: c, shared: true }]));
      // Make the order differ from creation order.
      const order = [3, 0, 6, 1, 5, 2, 4];
      for (const [k, c] of order.entries()) {
        await testDb.execute(sql`UPDATE collections SET updated_at = ${`2026-0${1 + (k % 9)}-01T00:00:00Z`}::timestamptz WHERE slug = ${slugs[c]}`);
      }
      const listed = await collectionsSvc.listCollections(USER_ID, ORG_ID);
      expect(listed.map((c) => c.slug)).toEqual([...order].reverse().map((c) => slugs[c]));
      for (const c of listed) {
        const n = Number(c.slug.match(/many_(\d)/)?.[1] ?? c.name.match(/(\d)$/)?.[1]);
        expect(c.fields).toEqual([`f${n}`, "shared"].sort());
      }
    });
  });
});
