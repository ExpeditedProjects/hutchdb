import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Query semantics of the table layout against real Postgres, each checked
// against an in-memory oracle and between a projected/unwound collection
// and an identical one evaluated over the documents only:
// - arrays of scalars in filters (Mongo semantics) and indexed honesty;
// - sum/avg/min/max over booleans, and type errors instead of silent nulls;
// - multi-key sort for records and aggregates;
// - group_by on arrays of scalars (per element) and on arrays of objects
//   (totals across parents, per_record on request), typed group keys;
// - unwind inference across batches, its pending reasons, merges and
//   failures; transform's filter; collection names in place of slugs.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "semantics-user";
const ORG_ID = "semantics-org";

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
  warnings?: string[];
};

function ok<T>(result: T): Exclude<T, { error: unknown } | null | undefined> {
  if (result == null || (typeof result === "object" && "error" in (result as object))) {
    throw new Error(`Expected success result, got: ${JSON.stringify(result)}`);
  }
  return result as Exclude<T, { error: unknown } | null | undefined>;
}

type Answer = {
  answer_id: number;
  author: { user_id?: number; name: string };
  score: number;
  is_accepted: boolean;
  tags?: string[] | string;
  nums: number[];
  code: number | number[];
  tag_list: { tag: string; score: number }[];
};

const TAGS = ["hiking", "snow", "camping", "day-hiking", "knots", "gear"];

function makeAnswers(n: number, offset = 0): Answer[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + offset;
    const tags: string[] | string | undefined = i % 10 === 0 ? undefined : i % 10 === 1 ? [] : i % 10 === 2 ? "hiking" : [TAGS[i % 6], TAGS[(i * 5) % 6], TAGS[(i + 2) % 6]].slice(0, 1 + (i % 3));
    const list = Array.isArray(tags) ? [...new Set(tags)] : [];
    return {
      answer_id: i,
      author: { ...(i % 37 === 0 ? {} : { user_id: i % 12 }), name: `user${i % 12}` },
      score: ((i * 7) % 23) - 5,
      is_accepted: i % 3 === 0,
      ...(tags === undefined ? {} : { tags: Array.isArray(tags) ? [...new Set(tags)] : tags }),
      nums: [i % 5, (i * 3) % 11],
      code: i % 20 === 0 ? [i % 7, 5] : i % 7,
      tag_list: list.map((tag) => ({ tag, score: i % 5 })),
    };
  });
}

// ── Mongo-semantics oracle ──────────────────────────────────────────────────

function valueAt(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
const scalarEq = (v: unknown, x: unknown) => v === x;
const some = (v: unknown, pred: (e: unknown) => boolean) => pred(v) || (Array.isArray(v) && v.some(pred));
function matches(doc: unknown, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, spec]) => {
    const v = valueAt(doc, field);
    const ops = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : { $eq: spec };
    return Object.entries(ops).every(([op, x]) => {
      switch (op) {
        case "$eq": return Array.isArray(x) ? Array.isArray(v) && x.every((e) => v.includes(e)) : some(v, (e) => scalarEq(e, x));
        case "$ne": return !some(v, (e) => scalarEq(e, x));
        case "$in": return (x as unknown[]).some((y) => some(v, (e) => scalarEq(e, y)));
        case "$nin": return !(x as unknown[]).some((y) => some(v, (e) => scalarEq(e, y)));
        case "$gt": return some(v, (e) => typeof e === typeof x && (e as number) > (x as number));
        case "$lte": return some(v, (e) => typeof e === typeof x && (e as number) <= (x as number));
        case "$contains": return some(v, (e) => typeof e === "string" && e.toLowerCase().includes((x as string).toLowerCase()));
        case "$exists": return (v !== undefined) === x;
        default: throw new Error(`oracle: ${op}`);
      }
    });
  });
}

/** Per-element groups of a value: an array's elements, else the value itself (missing / empty -> null). */
function groupValues(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.length > 0 ? v : [null];
  return [v === undefined ? null : v];
}

describe.skipIf(!TEST_DB_URL)("table layout query semantics against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_STORAGE_LAYOUT", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  function thresholds(project: number, unwind = project) {
    process.env.HUTCH_PROJECT_THRESHOLD = String(project);
    process.env.HUTCH_UNWIND_THRESHOLD = String(unwind);
  }

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    process.env.HUTCH_STORAGE_LAYOUT = "table";
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });

    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    appPool = (await import("@/lib/db")).db.$client as Pool;

    await testDb.insert(schema.user).values({ id: USER_ID, email: "semantics@hutch.test", name: "Semantics" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "semantics", name: "Semantics", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    process.env.HUTCH_STORAGE_LAYOUT = "table";
    thresholds(100);
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

  async function store(collection: string, recs: Record<string, unknown>[], on_conflict?: string): Promise<string> {
    const result = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection, records: recs, return: "summary", on_conflict }));
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
    const id = (await collectionRow(slug)).id;
    await testDb.execute(sql`ANALYZE ${sql.identifier(`hc_${id}`)}`);
  }

  /** Every response: `indexed` and the plan text never contradict each other. */
  function checkReport(r: QueryResult) {
    expect(typeof r.indexed).toBe("boolean");
    if (r.indexed) expect(r.plan).toMatch(/using /);
    else if (/using /.test(r.plan ?? "")) expect(r.plan).toMatch(/serving none of the query's clauses/);
  }

  async function query(slug: string, params: QueryParams): Promise<QueryResult> {
    const r = ok(await recordsSvc.queryRecords(slug, USER_ID, params)) as QueryResult;
    checkReport(r);
    return r;
  }

  /** The same answers stored twice: projected/unwound at 100, and never (documents only). */
  async function twin(docs: Record<string, unknown>[]) {
    thresholds(100);
    const projected = await store("projected", docs);
    thresholds(1_000_000_000);
    const plain = await store("plain", docs);
    thresholds(100);
    await analyze(projected);
    await analyze(plain);
    return { projected, plain };
  }

  const ids = (r: QueryResult) => r.records!.map((x) => (x.data as Answer).answer_id);

  describe("arrays of scalars in filters", () => {
    const docs = makeAnswers(300);
    const FILTERS: Record<string, unknown>[] = [
      { tags: "hiking" },
      { tags: { $in: ["snow", "knots"] } },
      { tags: { $contains: "hik" } },
      { tags: { $ne: "hiking" } },
      { tags: { $nin: ["hiking", "snow"] } },
      { tags: ["hiking", "snow"] },
      { tags: { $exists: false } },
      { nums: 3 },
      { nums: { $gt: 9 } },
      { nums: { $in: [0, 10] } },
      { code: 5 },
      { code: { $ne: 5 } },
      { code: { $in: [5, 6] } },
      { code: { $nin: [5, 6] } },
      { code: { $gt: 5 } },
      { code: { $lte: 0 } },
      { "author.user_id": 3, tags: "camping" },
      { "author.user_id": { $exists: true }, tags: { $in: ["gear"] } },
    ];

    it("match when some element matches, the same projected or not, and as the oracle says", async () => {
      const { projected, plain } = await twin(docs);
      const reg = await registry(projected);
      expect(reg.projections.find((p) => p.field === "code")).toMatchObject({ type: "number", mixed: true });
      expect(reg.projections.some((p) => p.field === "tags" || p.field === "nums")).toBe(false);
      expect((await registry(plain)).projections).toEqual([]);

      for (const filter of FILTERS) {
        const params = { filter, sort: "answer_id", limit: 1000 };
        const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
        const expected = docs.filter((d) => matches(d, filter)).map((d) => d.answer_id);
        expect(ids(a), `${JSON.stringify(filter)}: projected vs oracle`).toEqual(expected);
        expect(ids(b), `${JSON.stringify(filter)}: documents vs oracle`).toEqual(expected);
        expect(a.total).toBe(expected.length);
      }
      // The report's three silent-zero forms now find the hiking answers.
      const hiking = docs.filter((d) => matches(d, { tags: "hiking" })).length;
      expect(hiking).toBeGreaterThan(50);
      await expect(query(plain, { filter: { tags: { $contains: ["hiking"] } } })).rejects.toThrow(/requires a string operand/);
    });

    it("an index reported as used serves the array clause and the answer is right", async () => {
      const big = makeAnswers(4000).map((d, i) => (i % 400 === 7 ? { ...d, tags: ["rare-tag", "snow"] } : d));
      const slug = await store("big", big);
      await analyze(slug);
      for (const filter of [{ tags: "rare-tag" }, { tags: { $in: ["rare-tag", "nope"] } }]) {
        const r = await query(slug, { filter, sort: "answer_id", limit: 1000 });
        expect(ids(r)).toEqual(big.filter((d) => matches(d, filter)).map((d) => d.answer_id));
        expect(r.indexed).toBe(true);
        expect(r.plan).toMatch(/hc_\d+_data_gin_idx/);
      }
      // $exists on an unmixed projection uses its column (and says so only if an index served it).
      const exists = await query(slug, { filter: { "author.user_id": { $exists: false } }, sort: "answer_id", limit: 1000 });
      expect(ids(exists)).toEqual(big.filter((d) => d.author.user_id === undefined).map((d) => d.answer_id));
    });
  });

  describe("aggregates over booleans and other types", () => {
    it("sum/avg count true as 1, min/max return booleans, the same projected or not", async () => {
      const docs = makeAnswers(300);
      const { projected, plain } = await twin(docs);
      expect((await registry(projected)).projections.find((p) => p.field === "is_accepted")?.type).toBe("boolean");
      const params: QueryParams = { aggregate: { acc: { sum: "is_accepted" }, share: { avg: "is_accepted" }, lo: { min: "is_accepted" }, hi: { max: "is_accepted" }, n: "count" } };
      const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
      const accepted = docs.filter((d) => d.is_accepted).length;
      expect(a.results![0]).toMatchObject({ acc: accepted, lo: false, hi: true, n: 300 });
      expect(a.results![0].share as number).toBeCloseTo(accepted / 300, 10);
      expect(a.results).toEqual(b.results);
    });

    it("an aggregate over only strings is an error naming the type; partly affected groups warn", async () => {
      const docs = makeAnswers(50);
      const slug = await store("strings", [...docs, { answer_id: 999, author: { user_id: 99, name: "x" }, score: "n/a" }]);
      await expect(query(slug, { aggregate: { s: { sum: "author.name" } } })).rejects.toThrow(/sum 's' over 'author.name' found string values/);
      const grouped = await query(slug, { groupBy: "author.user_id", aggregate: { s: { sum: "score" } }, limit: 100 });
      expect(grouped.results!.find((r) => r["author.user_id"] === 99)).toMatchObject({ s: null });
      expect(grouped.warnings).toEqual([expect.stringMatching(/sum 's' over 'score' is null in 1 of \d+ groups, whose values are string/)]);
    });
  });

  describe("multi-key sort", () => {
    it("orders records and aggregate rows by up to three keys, projected or not", async () => {
      const docs = makeAnswers(300);
      const { projected, plain } = await twin(docs);
      const oracle = docs.slice().sort((x, y) => y.score - x.score || x.answer_id - y.answer_id).slice(0, 25).map((d) => d.answer_id);
      for (const sort of ["-score,answer_id", ["-score", "answer_id"]]) {
        for (const slug of [projected, plain]) {
          expect(ids(await query(slug, { sort, limit: 25 }))).toEqual(oracle);
        }
      }

      // The tag-board shape: accepted desc, total score desc, user asc.
      const groups = new Map<number, { acc: number; total: number }>();
      for (const d of docs) {
        if (d.author.user_id === undefined) continue;
        const g = groups.get(d.author.user_id) ?? { acc: 0, total: 0 };
        g.acc += d.is_accepted ? 1 : 0;
        g.total += d.score;
        groups.set(d.author.user_id, g);
      }
      const board = [...groups.entries()].map(([user, g]) => ({ "author.user_id": user, ...g }))
        .sort((x, y) => y.acc - x.acc || y.total - x.total || x["author.user_id"] - y["author.user_id"]).slice(0, 5);
      const params: QueryParams = {
        filter: { "author.user_id": { $exists: true } },
        groupBy: "author.user_id",
        aggregate: { acc: { sum: "is_accepted" }, total: { sum: "score" } },
        sort: "-acc,-total,author.user_id",
        limit: 5,
      };
      const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
      expect(a.results).toEqual(board);
      expect(b.results).toEqual(board);
      // Group keys keep their JSON type.
      expect(typeof a.results![0]["author.user_id"]).toBe("number");
      await expect(query(plain, { sort: "a,b,c,d" })).rejects.toThrow(/at most 3 keys/);
    });
  });

  it("an over-long string in a projected text field is stored and queried like the document path", async () => {
    const docs = makeAnswers(300).map((d) => ({ ...d, title: `t-${d.answer_id % 50}` }));
    const { projected, plain } = await twin(docs);
    const before = await registry(projected);
    expect(before.projections.find((p) => p.field === "title")).toMatchObject({ type: "text" });
    expect(before.projections.find((p) => p.field === "title")?.mixed).toBeUndefined();
    expect(before.unwinds.find((u) => u.path === "tag_list")?.fields.find((f) => f.field === "tag")?.type).toBe("text");

    // 10 KB that does not compress: well past the ~2.7 KB btree entry
    // limit of the column's index (a repeated character would compress under it).
    let seed = 7;
    const noise = Array.from({ length: 10 * 1024 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return String.fromCharCode(97 + (seed % 26));
    }).join("");
    const long = `t-zz${noise}needle`;
    const longDoc = { ...makeAnswers(1, 1000)[0], title: long, tag_list: [{ tag: long, score: 1 }, { tag: "snow", score: 2 }] };
    await store("projected", [longDoc]);
    await store("plain", [longDoc]);
    const all = [...docs, longDoc];
    expect((await registry(projected)).projections.find((p) => p.field === "title")?.mixed).toBe(true);

    const FILTERS: Record<string, unknown>[] = [
      { title: long },
      { title: "t-3" },
      { title: { $contains: "needle" } },
      { title: { $contains: "T-1" } },
      { title: { $in: [long, "t-7"] } },
      { title: { $ne: "t-3" } },
      { title: { $nin: [long] } },
      { title: { $exists: true } },
      { "tag_list.tag": long },
      { "tag_list.tag": { $contains: "needle" } },
    ];
    // The oracle walks objects only; an array-of-objects path matches when some element does.
    const oracle = (d: (typeof all)[number], filter: Record<string, unknown>) => {
      const [field, spec] = Object.entries(filter)[0];
      if (!field.startsWith("tag_list.")) return matches(d, filter);
      return d.tag_list.some((t) => matches({ tag: t.tag }, { tag: spec }));
    };
    for (const filter of FILTERS) {
      const params = { filter, sort: "answer_id", limit: 1000 };
      const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
      const expected = all.filter((d) => oracle(d, filter)).map((d) => d.answer_id);
      expect(ids(a), `${JSON.stringify(filter).slice(0, 80)}: projected vs oracle`).toEqual(expected);
      expect(ids(b), `${JSON.stringify(filter).slice(0, 80)}: documents vs oracle`).toEqual(expected);
    }
    // Ranges and sorts compare as text in Postgres' collation: the projected
    // collection must agree with the document-only one.
    for (const params of [
      { filter: { title: { $gt: "t-4" } }, sort: "answer_id", limit: 1000 },
      { filter: { title: { $lte: "t-zz" } }, sort: "answer_id", limit: 1000 },
      { filter: { "tag_list.tag": { $gt: "t" } }, sort: "answer_id", limit: 1000 },
      { sort: ["title", "answer_id"], limit: 1000 },
      { sort: ["-title", "answer_id"], limit: 1000 },
    ] as QueryParams[]) {
      const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
      expect(ids(a), JSON.stringify(params)).toEqual(ids(b));
      expect(a.total).toBe(b.total);
    }
    const [ga, gb] = await Promise.all([
      query(projected, { groupBy: "title", aggregate: { n: "count" }, sort: ["-n", "title"], limit: 5 }),
      query(plain, { groupBy: "title", aggregate: { n: "count" }, sort: ["-n", "title"], limit: 5 }),
    ]);
    expect(ga.results).toEqual(gb.results);
  });

  describe("group_by on arrays", () => {
    it("groups an array of scalars per element (a tag board without a join collection)", async () => {
      const docs = makeAnswers(300);
      const { projected, plain } = await twin(docs);
      const counts = new Map<unknown, { n: number; s: number }>();
      for (const d of docs) {
        for (const tag of groupValues(d.tags)) {
          const g = counts.get(tag) ?? { n: 0, s: 0 };
          g.n++;
          g.s += d.score;
          counts.set(tag, g);
        }
      }
      const expected = [...counts.entries()].map(([tags, g]) => ({ tags, ...g }))
        .sort((x, y) => y.n - x.n || String(x.tags ?? "￿").localeCompare(String(y.tags ?? "￿")));
      const params: QueryParams = { groupBy: "tags", aggregate: { n: "count", s: { sum: "score" } }, sort: ["-n", "tags"], limit: 100 };
      const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
      expect(a.results).toEqual(expected);
      expect(b.results).toEqual(expected);
      expect(a.total).toBe(expected.length);

      // "A user's top 3 tags across their answers", in one query on the natural shape.
      const mine = docs.filter((d) => d.author.user_id === 3);
      const per = new Map<string, number>();
      for (const d of mine) for (const t of groupValues(d.tags)) if (t !== null) per.set(t as string, (per.get(t as string) ?? 0) + d.score);
      const top = [...per.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([tags, s]) => ({ tags, s }));
      const r = await query(projected, { filter: { "author.user_id": 3, tags: { $exists: true } }, groupBy: "tags", aggregate: { s: { sum: "score" } }, sort: "-s,tags", limit: 4 });
      expect(r.results!.filter((x) => x.tags !== null).slice(0, 3)).toEqual(top);

      // A mixed scalar/array field groups per element too, keeping numbers.
      const code = await query(plain, { groupBy: "code", aggregate: { n: "count" }, limit: 100 });
      const codes = new Map<unknown, number>();
      for (const d of docs) for (const c of groupValues(d.code)) codes.set(c, (codes.get(c) ?? 0) + 1);
      expect(code.results).toEqual([...codes.entries()].sort((x, y) => (x[0] as number) - (y[0] as number)).map(([c, n]) => ({ code: c, n })));
    });

    it("totals a path into an array of objects across parents, with parent fields alongside; per_record on request", async () => {
      const docs = makeAnswers(300);
      const { projected, plain } = await twin(docs);
      expect((await registry(projected)).unwinds.map((u) => u.path)).toEqual(["tag_list"]);
      expect((await registry(plain)).unwinds).toEqual([]);

      const totals = new Map<string, { n: number; s: number; e: number }>();
      for (const d of docs) {
        for (const el of d.tag_list) {
          const g = totals.get(el.tag) ?? { n: 0, s: 0, e: 0 };
          g.n++;
          g.s += d.score; // parent field, once per element
          g.e += el.score;
          totals.set(el.tag, g);
        }
      }
      const expected = [...totals.entries()].map(([tag, g]) => ({ "tag_list.tag": tag, ...g })).sort((x, y) => x["tag_list.tag"].localeCompare(y["tag_list.tag"]));
      const params: QueryParams = { groupBy: "tag_list.tag", aggregate: { n: "count", s: { sum: "score" }, e: { sum: "tag_list.score" } }, limit: 100 };
      const [a, b] = await Promise.all([query(projected, params), query(plain, params)]);
      expect(a.results).toEqual(expected);
      expect(b.results).toEqual(expected);

      // A filter on the array applies to each element aggregated, unwound or not.
      const snowOnly = { ...params, filter: { "tag_list.tag": "snow" } };
      const [c, d] = await Promise.all([query(projected, snowOnly), query(plain, snowOnly)]);
      expect(c.results).toEqual(expected.filter((x) => x["tag_list.tag"] === "snow"));
      expect(d.results).toEqual(c.results);

      const perRecord = await query(projected, { ...params, perRecord: true, limit: 1000 });
      expect(perRecord.results!.length).toBe(docs.reduce((n, x) => n + x.tag_list.length, 0));
      expect(perRecord.results![0]).toHaveProperty("parent_id");
      expect(perRecord.results![0]).toHaveProperty("record");
    });
  });

  describe("unwind inference across batches", () => {
    const element = (i: number) => ({ item_id: i, qty: i % 4, body: "x".repeat(3000) });

    it("unwinds once the collection-wide element total crosses the threshold, saying why until then", async () => {
      const batch = (from: number) => Array.from({ length: 20 }, (_, k) => ({ order: from + k, note: "y".repeat(400), lines: [element(k), element(k + 1)] }));
      const slug = await store("orders", batch(0));
      expect((await registry(slug)).pending_unwinds).toEqual([{ path: "lines", reason: "'lines' holds 40 elements across the collection; it is unwound at 100." }]);
      await store("orders", batch(20));
      const described = ok(await collectionsSvc.describeCollection(slug, USER_ID)) as { storage: { not_unwound: { path: string; reason: string }[]; unwinds: unknown[] } };
      expect(described.storage.not_unwound).toEqual([{ path: "lines", reason: "'lines' holds 80 elements across the collection; it is unwound at 100." }]);
      expect(described.storage.unwinds).toEqual([]);

      await store("orders", batch(40));
      const reg = await registry(slug);
      expect(reg.unwinds.map((u) => [u.path, u.fields.map((f) => f.field)])).toEqual([["lines", ["item_id", "qty"]]]); // long body left out
      expect(reg.pending_unwinds).toBeUndefined();
      expect(reg.evaluated_rows).toBe(60);
      expect(reg.projections.map((p) => p.field)).toEqual(["order"]); // note is long text
      const r = await query(slug, { filter: { "lines.item_id": 3 }, sort: "order", limit: 100 });
      expect(r.total).toBe(60 * 2 / 20 * 1); // item_id 3 is in elements k=3 and k+1=3 of each batch: 2 docs per batch
    });

    it("evaluates the stored documents of a merge, so a merge-only batch can unwind", async () => {
      thresholds(100, 1000);
      const docs = Array.from({ length: 60 }, (_, i) => ({ key: i, lines: [{ item_id: i, qty: 1 }, { item_id: i + 1, qty: 2 }] }));
      const slug = await store("merged", docs);
      ok(await collectionsSvc.updateCollection(slug, USER_ID, { unique_key: ["key"] }));
      expect((await registry(slug)).unwinds).toEqual([]);
      thresholds(100, 100);
      await store("merged", docs.map((d) => ({ key: d.key, seen: true })), "merge");
      expect((await registry(slug)).unwinds.map((u) => u.path)).toEqual(["lines"]);
    });

    it("records a failed unwind as pending, still counts the batch and applies the other decisions", async () => {
      const slug = await store("broken", [{ seed: 1 }]);
      const id = (await collectionRow(slug)).id;
      // A table squatting on the child name makes the unwind's backfill fail.
      await testDb.execute(sql`CREATE TABLE ${sql.identifier(`hc_${id}__lines`)} (parent_id int, idx int)`);
      const docs = Array.from({ length: 120 }, (_, i) => ({ n: i, lines: [{ item_id: i }] }));
      await store("broken", docs);
      const reg = await registry(slug);
      expect(reg.unwinds).toEqual([]);
      expect(reg.pending_unwinds).toEqual([{ path: "lines", reason: expect.stringMatching(/^unwinding 'lines' failed \(.+\); it is retried after the next write\.$/) }]);
      expect(reg.evaluated_rows).toBe(121);
      expect(reg.projections.map((p) => p.field)).toContain("n");
      expect((await query(slug, { filter: { "lines.item_id": 5 } })).total).toBe(1);
    });
  });

  it("transform's set_field.filter takes the query filter language", async () => {
    const docs = makeAnswers(120);
    const slug = await store("transform", docs);
    const hiking = ok(await recordsSvc.transformRecords(slug, USER_ID, { set_field: { field: "flag", value: "hiking", filter: { tags: "hiking" } } }));
    expect(hiking.updated).toBe(docs.filter((d) => matches(d, { tags: "hiking" })).length);
    const high = ok(await recordsSvc.transformRecords(slug, USER_ID, { set_field: { field: "high", value: true, filter: { score: { $gt: 10 }, "author.user_id": { $exists: true } } } }));
    expect(high.updated).toBe(docs.filter((d) => d.score > 10 && d.author.user_id !== undefined).length);
    const flagged = await query(slug, { filter: { flag: "hiking" }, sort: "answer_id", limit: 1000 });
    expect(ids(flagged)).toEqual(docs.filter((d) => matches(d, { tags: "hiking" })).map((d) => d.answer_id));
  });

  it("every tool taking a slug also takes the collection's name when it is unambiguous", async () => {
    const slug = await store("tags", [{ tag_id: 1, name: "hiking" }]);
    expect(slug).toMatch(/^tags-[0-9a-f]{8}$/);
    expect((await collectionRow(slug)).name).toBe("Tags");

    ok(await collectionsSvc.updateCollection("tags", USER_ID, { unique_key: ["tag_id"] }));
    expect((await collectionRow(slug)).uniqueKey).toEqual(["tag_id"]);
    expect((await query("tags", {})).total).toBe(1);
    expect((ok(await collectionsSvc.describeCollection("Tags", USER_ID)) as { slug: string }).slug).toBe(slug);
    const t = ok(await recordsSvc.transformRecords("tags", USER_ID, { set_field: { field: "seen", value: true } }));
    expect(t.slug).toBe(slug);

    // A second collection whose name differs only in case: the exact name still resolves, "tags" no longer does.
    ok(await collectionsSvc.createCollection(USER_ID, ORG_ID, { name: "TAGS" }));
    expect(await recordsSvc.queryRecords("tags", USER_ID, {})).toBeNull();
    expect((ok(await collectionsSvc.describeCollection("Tags", USER_ID)) as { slug: string }).slug).toBe(slug);
    expect(await collectionsSvc.describeCollection("nope", USER_ID)).toBeNull();
  });
});
