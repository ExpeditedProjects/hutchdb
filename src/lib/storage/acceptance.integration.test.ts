import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { projectData } from "./projection";

// ---------------------------------------------------------------------------
// Cases from the acceptance runs (dollarvote and Stack Exchange briefs)
// against real Postgres, each checked between a projected/unwound
// collection and an identical one evaluated over the documents only, and
// against the answer computed in JS from the documents:
// - fields into arrays of objects, array_sort / array_limit;
// - $or / $and;
// - {"count": "path"}, `first`, five group_by keys;
// - limit: 0 (count only);
// - a plain indexed equality filter reports indexed under the default order;
// - describe's distinct counts.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "acceptance-user";
const ORG_ID = "acceptance-org";

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");
type QueryParams = Parameters<RecordsService["queryRecords"]>[2];
type QueryResult = Record<string, unknown> & {
  records?: { id: number; data: unknown }[];
  results?: Record<string, unknown>[];
  total?: number;
  count?: number;
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

type Answer = { answer_id: number; score: number; is_accepted: boolean; owner?: { user_id: number; name: string }; body: string };
type Question = {
  question_id: number;
  title: string;
  owner_user_id: number;
  score: number;
  tags: string[];
  answers: Answer[];
  closed?: boolean;
  meta: { views: number; site: string };
};

/** Questions with 0–5 answers each; answers have mixed owners and a few without one. */
function makeQuestions(n: number): Question[] {
  return Array.from({ length: n }, (_, i) => ({
    question_id: 1000 + i,
    title: `Question ${i}`,
    owner_user_id: i % 17,
    score: ((i * 7) % 23) - 5,
    tags: [["git", "bash", "node"][i % 3], ...(i % 4 === 0 ? ["linux"] : [])],
    answers: Array.from({ length: i % 6 }, (_, k) => ({
      answer_id: i * 10 + k,
      score: ((i + k * 5) % 13) - 3,
      is_accepted: k === 1,
      ...(k % 4 === 3 ? {} : { owner: { user_id: (i + k) % 9, name: `user${(i + k) % 9}` } }),
      body: `answer ${k} to ${i}`,
    })),
    ...(i % 5 === 0 ? { closed: true } : {}),
    meta: { views: i * 3, site: i % 2 === 0 ? "so" : "su" },
  }));
}

type Vote = { bill_id: string; vote: string; points: Record<string, number>; possible: Record<string, number> };
type Legislator = { bioguide_id: string; name: string; party: string; state: string; chamber: string; votes: Vote[] };

const CATEGORIES = ["veterans", "small_business", "energy"];

/** Legislators with votes; each vote scores in one or two categories, some in none. */
function makeLegislators(n: number): Legislator[] {
  return Array.from({ length: n }, (_, i) => ({
    bioguide_id: `B${String(i).padStart(5, "0")}`,
    name: `Member ${String.fromCharCode(65 + (i % 26))}${i}`,
    party: ["D", "R", "I"][i % 3],
    state: ["CA", "TX", "NY", "OH"][i % 4],
    chamber: i % 5 === 0 ? "senate" : "house",
    votes: Array.from({ length: 2 + (i % 7) }, (_, k) => {
      const points: Record<string, number> = {};
      const possible: Record<string, number> = {};
      const c1 = CATEGORIES[(i + k) % 3];
      if ((i + k) % 4 !== 0) {
        points[c1] = (i * k) % 3;
        possible[c1] = 2;
      }
      if (k % 3 === 1) {
        const c2 = CATEGORIES[(i + k + 1) % 3];
        points[c2] = (i + k) % 2;
        possible[c2] = 1;
      }
      return { bill_id: `HR${100 + ((i * 3 + k) % 40)}`, vote: k % 2 === 0 ? "yea" : "nay", points, possible };
    }),
  }));
}

/** Mongo-style oracle for the filters these tests use (top-level and one level into an array of objects). */
function valueAt(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
function fieldMatches(v: unknown, spec: unknown): boolean {
  const ops = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : { $eq: spec };
  return Object.entries(ops).every(([op, x]) => {
    switch (op) {
      case "$eq": return v === x;
      case "$gt": return typeof v === typeof x && (v as number) > (x as number);
      case "$lte": return typeof v === typeof x && (v as number) <= (x as number);
      case "$in": return (x as unknown[]).includes(v);
      case "$exists": return (v !== undefined) === x;
      default: throw new Error(`oracle: ${op}`);
    }
  });
}
/** Conditions on one array of objects in the same filter object must hold for the same element. */
function oracle(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  const perArray = new Map<string, [string, unknown][]>();
  const ok = Object.entries(filter).every(([key, spec]) => {
    if (key === "$or") return (spec as Record<string, unknown>[]).some((b) => oracle(doc, b));
    if (key === "$and") return (spec as Record<string, unknown>[]).every((b) => oracle(doc, b));
    const [head, ...rest] = key.split(".");
    if (Array.isArray(doc[head]) && rest.length > 0) {
      perArray.set(head, [...(perArray.get(head) ?? []), [rest.join("."), spec]]);
      return true;
    }
    return fieldMatches(valueAt(doc, key), spec);
  });
  // Positive conditions hold for one element together; {$exists: false} means no element has the path.
  const negative = (spec: unknown) => JSON.stringify(spec) === '{"$exists":false}';
  return ok && [...perArray].every(([head, conds]) => {
    const els = doc[head] as unknown[];
    const pos = conds.filter(([, spec]) => !negative(spec));
    const neg = conds.filter(([, spec]) => negative(spec));
    return neg.every(([path]) => els.every((el) => valueAt(el, path) === undefined))
      && (pos.length === 0 || els.some((el) => pos.every(([path, spec]) => fieldMatches(valueAt(el, path), spec))));
  });
}

describe.skipIf(!TEST_DB_URL)("acceptance-run cases against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  function thresholds(project: number, unwind = project) {
    process.env.HUTCH_PROJECT_THRESHOLD = String(project);
    process.env.HUTCH_UNWIND_THRESHOLD = String(unwind);
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

    await testDb.insert(schema.user).values({ id: USER_ID, email: "acceptance@hutch.test", name: "Acceptance" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "acceptance", name: "Acceptance", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    thresholds(100);
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\\_%'`);
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
    // Writes only queue index builds; run the background builder as the MCP route's after() would.
    await settle();
    return (result as { collection: { slug: string } }).collection.slug;
  }

  /** What the MCP route runs after a response: build every queued index and unwind. */
  async function settle() {
    const { buildPendingIndexes } = await import("./builder");
    const report = await buildPendingIndexes();
    // Every build must succeed, or a "projected vs plain" comparison could have both sides reading documents.
    expect(report.failed, JSON.stringify(report)).toBe(0);
    expect(report.collections.filter((c) => c.skipped)).toEqual([]);
    const { buildEntries, readRegistry } = await import("./registry");
    const rows = (await testDb.execute(sql`SELECT id, storage FROM collections`)).rows as { id: number; storage: unknown }[];
    expect(rows.flatMap((r) => buildEntries(readRegistry(r.storage)).filter((e) => e.build && e.build.state !== "ready").map((e) => `${r.id} ${e.kind} ${e.key}: ${e.build!.state}`))).toEqual([]);
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

  async function query(slug: string, params: QueryParams): Promise<QueryResult> {
    const r = ok(await recordsSvc.queryRecords(slug, USER_ID, params)) as QueryResult;
    expect(typeof r.indexed).toBe("boolean");
    if (r.indexed) expect(r.plan).toMatch(/using /);
    return r;
  }

  /** The same documents stored twice: projected/unwound at 100, and never (documents only). */
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

  /** Records' data in question_id order, for comparing two collections. */
  const dataById = (r: QueryResult) =>
    [...r.records!].map((x) => x.data as Record<string, unknown>).sort((a, b) => (a.question_id as number) - (b.question_id as number));

  // ── 1. fields into arrays of objects; array_sort / array_limit ────────────

  describe("fields and embedded arrays", () => {
    const docs = makeQuestions(300);

    it("returns each answer reduced to the listed keys, combining siblings, identically projected or not", async () => {
      const { projected, plain } = await twin(docs);
      expect((await registry(projected)).unwinds.map((u) => u.path)).toContain("answers");
      const fields = ["question_id", "title", "answers.answer_id", "answers.score", "answers.owner.name"];
      const filter = { owner_user_id: 4 };
      const expected = docs.filter((d) => d.owner_user_id === 4).map((d) => projectData(d, fields));
      for (const slug of [projected, plain]) {
        const r = await query(slug, { filter, fields, limit: 100 });
        expect(dataById(r)).toEqual(expected);
        // Spot check the shape the acceptance run asked for.
        const withAnswers = dataById(r).find((d) => (d.answers as unknown[]).length > 1)!;
        expect(Object.keys((withAnswers.answers as Record<string, unknown>[])[0]).sort()).toEqual(["answer_id", "owner", "score"]);
      }
    });

    it("a fields entry no record has is an error, never dropped, including a typo below an array", async () => {
      const { projected, plain } = await twin(docs);
      for (const slug of [projected, plain]) {
        await expect(query(slug, { fields: ["title", "answers.answer_idd"] })).rejects.toThrow(/Invalid field 'answers.answer_idd' in fields: no record/);
        await expect(query(slug, { fields: ["nope"] })).rejects.toThrow(/Invalid field 'nope'/);
        await expect(query(slug, { fields: ["meta.views.x"] })).rejects.toThrow(/Invalid field 'meta.views.x'/);
        await expect(query(slug, { fields: ["a..b"] })).rejects.toThrow(/Invalid field 'a..b'/);
        // fields cannot shape aggregate columns.
        await expect(query(slug, { groupBy: "owner_user_id", fields: ["title"] })).rejects.toThrow(/shape returned records/);
      }
    });

    it("top 2 answers by score: array_sort plus array_limit, the same either way and as computed in JS", async () => {
      const { projected, plain } = await twin(docs);
      const filter = { question_id: { $in: [1005, 1011, 1017, 1023] } };
      const expected = docs
        .filter((d) => [1005, 1011, 1017, 1023].includes(d.question_id))
        .map((d) => ({
          question_id: d.question_id,
          answers: [...d.answers]
            .sort((a, b) => b.score - a.score || a.answer_id - b.answer_id)
            .slice(0, 2)
            .map((a) => ({ answer_id: a.answer_id, score: a.score })),
        }));
      for (const slug of [projected, plain]) {
        const r = await query(slug, { filter, fields: ["question_id", "answers.answer_id", "answers.score"], arraySort: { answers: "-score,answer_id" }, arrayLimit: { answers: 2 } });
        expect(dataById(r)).toEqual(expected);
        // array_totals reports the full length of each array array_limit cut, and nothing for arrays it left whole.
        for (const rec of r.records! as { data: Question; array_totals?: Record<string, number> }[]) {
          const full = docs.find((d) => d.question_id === rec.data.question_id)!.answers.length;
          expect(rec.array_totals).toEqual(full > 2 ? { answers: full } : undefined);
        }
      }
    });

    it("first 3 answer owners by name, missing names last, without fields", async () => {
      const { projected } = await twin(docs);
      const doc = docs.find((d) => d.question_id === 1004)!;
      const r = await query(projected, { filter: { question_id: 1004 }, arraySort: { answers: "owner.name" }, arrayLimit: { answers: 3 } });
      const names = (r.records![0].data as Question).answers.map((a) => a.owner?.name ?? null);
      const expectedNames = doc.answers.map((a) => a.owner?.name ?? null).sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0)).slice(0, 3);
      expect(names).toEqual(expectedNames);
      // The rest of the document is untouched.
      expect((r.records![0].data as Question).title).toBe(doc.title);
    });

    it("array_sort / array_limit paths and keys are checked", async () => {
      const { projected } = await twin(docs);
      await expect(query(projected, { arraySort: { title: "x" } })).rejects.toThrow(/no record in this collection holds an array there/);
      await expect(query(projected, { arraySort: { answers: "-scor" } })).rejects.toThrow(/Invalid array_sort key 'scor' for 'answers'/);
      await expect(query(projected, { fields: ["title"], arrayLimit: { answers: 2 } })).rejects.toThrow(/not returned by fields/);
      await expect(query(projected, { groupBy: "owner_user_id", arrayLimit: { answers: 2 } })).rejects.toThrow(/shape returned records/);
    });

    it("per_record aggregates project paths in the attached record", async () => {
      const { projected, plain } = await twin(docs);
      const params: QueryParams = {
        filter: { question_id: { $in: [1004, 1005] } },
        groupBy: "answers.is_accepted",
        perRecord: true,
        fields: ["title", "answers.answer_id"],
        arraySort: { answers: "-answer_id" },
        arrayLimit: { answers: 1 },
        sort: "answers.is_accepted",
      };
      const a = await query(projected, params);
      const b = await query(plain, params);
      const strip = (r: QueryResult) => r.results!.map((x) => ({ ...x, parent_id: undefined, record: { data: (x.record as { data: unknown }).data } }));
      expect(strip(a)).toEqual(strip(b));
      const rec = a.results!.find((x) => (x.record as { data: Question }).data.title === "Question 5")!.record as { data: Record<string, unknown> };
      expect(rec.data).toEqual({ title: "Question 5", answers: [{ answer_id: 54 }] });
    });
  });

  // ── 2. $or / $and ─────────────────────────────────────────────────────────

  describe("$or / $and", () => {
    const docs = makeQuestions(300);
    const FILTERS: Record<string, unknown>[] = [
      { $or: [{ owner_user_id: 4 }, { owner_user_id: 9 }] },
      { $or: [{ closed: true }, { score: { $gt: 15 } }] },
      { $or: [{ "answers.score": { $gt: 8 } }, { owner_user_id: 3 }] },
      { owner_user_id: { $lte: 8 }, $or: [{ "answers.is_accepted": true, "answers.score": { $gt: 5 } }, { closed: true }] },
      { $and: [{ $or: [{ owner_user_id: 1 }, { owner_user_id: 2 }] }, { $or: [{ closed: true }, { "meta.site": "so" }] }] },
      { $or: [{ "answers.owner.user_id": 3 }, { "answers.answer_id": { $in: [11, 12] } }] },
      { $or: [{ "answers.owner": { $exists: false }, closed: true }, { question_id: 1001 }] },
    ];

    it("matches the Mongo answer, projected/unwound or not", async () => {
      const { projected, plain } = await twin(docs);
      for (const filter of FILTERS) {
        const expected = docs.filter((d) => oracle(d as unknown as Record<string, unknown>, filter)).map((d) => d.question_id).sort((a, b) => a - b);
        expect(expected.length, JSON.stringify(filter)).toBeGreaterThan(0);
        for (const slug of [projected, plain]) {
          const r = await query(slug, { filter, fields: ["question_id"], limit: 1000 });
          expect(r.records!.map((x) => (x.data as Question).question_id).sort((a, b) => a - b), `${slug} ${JSON.stringify(filter)}`).toEqual(expected);
          expect(r.total).toBe(expected.length);
        }
      }
    });

    it("an indexed $or of equalities can be served by the index", async () => {
      const many = makeQuestions(3000);
      const slug = await store("many", many);
      await analyze(slug);
      const r = await query(slug, { filter: { $or: [{ owner_user_id: 4 }, { question_id: 1003 }] }, limit: 5 });
      expect(r.total).toBe(many.filter((d) => d.owner_user_id === 4 || d.question_id === 1003).length);
      expect(r.indexed).toBe(true);
    });

    it("rejects unsupported top-level operators instead of matching nothing", async () => {
      const { projected } = await twin(docs);
      await expect(query(projected, { filter: { $nor: [{ owner_user_id: 4 }] } })).rejects.toThrow(/Supported: \$and, \$or/);
      await expect(query(projected, { filter: { $or: [] } })).rejects.toThrow(/non-empty array/);
    });

    it("the dollarvote board: $or of $exists on two nested paths, grouped per legislator", async () => {
      const legs = makeLegislators(150);
      const { projected, plain } = await twin(legs as unknown as Record<string, unknown>[]);
      const filter = { $or: [{ "votes.points.veterans": { $exists: true } }, { "votes.points.small_business": { $exists: true } }] };
      const params: QueryParams = {
        filter,
        groupBy: "bioguide_id",
        aggregate: { p_vet: { sum: "votes.points.veterans" }, p_sb: { sum: "votes.points.small_business" }, n: { count: "votes.bill_id" } },
        sort: "-p_vet,bioguide_id",
        limit: 1000,
      };
      // $or selects legislators; every vote of a selected legislator is aggregated.
      // A sum over no values is null, and nulls sort last.
      const sum = (l: Legislator, c: string) => (l.votes.some((v) => c in v.points) ? l.votes.reduce((s, v) => s + (v.points[c] ?? 0), 0) : null);
      const expected = legs
        .filter((l) => l.votes.some((v) => "veterans" in v.points || "small_business" in v.points))
        .map((l) => ({ bioguide_id: l.bioguide_id, p_vet: sum(l, "veterans"), p_sb: sum(l, "small_business"), n: l.votes.length }))
        .sort((a, b) => (a.p_vet === null ? 1 : 0) - (b.p_vet === null ? 1 : 0) || (b.p_vet ?? 0) - (a.p_vet ?? 0) || (a.bioguide_id < b.bioguide_id ? -1 : 1));
      for (const slug of [projected, plain]) {
        const r = await query(slug, params);
        expect(r.total).toBe(expected.length);
        expect(r.results!.map((x) => ({ ...x, p_vet: x.p_vet === null ? null : Number(x.p_vet), p_sb: x.p_sb === null ? null : Number(x.p_sb) }))).toEqual(expected);
      }
    });
  });

  // ── 3/4. {"count": path}, first, five group_by keys ───────────────────────

  describe("aggregates: count of a path, first, five keys", () => {
    const legs = makeLegislators(150);
    const KEYS = ["bioguide_id", "name", "party", "state", "chamber"] as const;

    /** The veterans board computed in JS: elements kept by `keep`, nulls (no values) sorted last. */
    function board(keep: (v: Vote) => boolean) {
      return legs
        .map((l) => {
          const votes = l.votes.filter(keep);
          const vet = votes.filter((v) => "veterans" in v.points);
          return {
            bioguide_id: l.bioguide_id, name: l.name, party: l.party, state: l.state, chamber: l.chamber,
            points: vet.length > 0 ? vet.reduce((s, v) => s + v.points.veterans, 0) : null,
            possible: vet.length > 0 ? vet.reduce((s, v) => s + v.possible.veterans, 0) : null,
            votes_counted: vet.length,
            rows: votes.length,
            first_bill: votes[0]?.bill_id ?? null,
          };
        })
        .filter((r) => r.rows > 0)
        .sort((a, b) => (a.points === null ? 1 : 0) - (b.points === null ? 1 : 0) || (b.points ?? 0) - (a.points ?? 0) || (a.bioguide_id < b.bioguide_id ? -1 : 1));
    }

    const params = (filter?: Record<string, unknown>): QueryParams => ({
      ...(filter ? { filter } : {}),
      groupBy: [...KEYS],
      aggregate: {
        points: { sum: "votes.points.veterans" },
        possible: { sum: "votes.possible.veterans" },
        votes_counted: { count: "votes.points.veterans" },
        rows: "count",
        first_bill: { first: "votes.bill_id" },
      },
      sort: "-points,bioguide_id",
      limit: 1000,
    });

    const normalize = (r: QueryResult) =>
      r.results!.map((x) => ({ ...x, points: x.points === null ? null : Number(x.points), possible: x.possible === null ? null : Number(x.possible) }));

    it("the dollarvote board with five group keys: a filter on the array restricts the elements; count of a path counts only elements that have it", async () => {
      const { projected, plain } = await twin(legs as unknown as Record<string, unknown>[]);
      const filtered = board((v) => "veterans" in v.points);
      const unfiltered = board(() => true);
      // Without the filter, rows counts every vote and votes_counted only the scored ones (the acceptance run's 330 vs 24).
      expect(unfiltered.some((r) => r.rows > r.votes_counted)).toBe(true);
      for (const slug of [projected, plain]) {
        const a = await query(slug, params({ "votes.points.veterans": { $exists: true } }));
        expect(a.total).toBe(filtered.length);
        expect(normalize(a)).toEqual(filtered);
        const b = await query(slug, params());
        expect(b.total).toBe(unfiltered.length);
        expect(normalize(b)).toEqual(unfiltered);
      }
    });

    it("first carries a pass-through column deterministically: the earliest-stored record's value", async () => {
      const { projected, plain } = await twin(legs as unknown as Record<string, unknown>[]);
      const expected = ["D", "I", "R"].map((party) => ({ party, n: legs.filter((l) => l.party === party).length, name: legs.find((l) => l.party === party)!.name }));
      for (const slug of [projected, plain]) {
        const r = await query(slug, { groupBy: "party", aggregate: { n: "count", name: { first: "name" } }, sort: "party" });
        expect(r.results).toEqual(expected);
      }
    });

    it("count of a path through an unwound array matches the documents, projected or not", async () => {
      const docs = makeQuestions(300);
      const { projected, plain } = await twin(docs);
      expect((await registry(projected)).unwinds.map((u) => u.path)).toContain("answers");
      const expected = [...new Set(docs.map((d) => d.meta.site))].sort().map((site) => {
        const answers = docs.filter((d) => d.meta.site === site).flatMap((d) => d.answers);
        return { "meta.site": site, all: answers.length, owned: answers.filter((a) => a.owner).length, first_id: answers[0].answer_id };
      });
      for (const slug of [projected, plain]) {
        const r = await query(slug, {
          filter: { "answers.answer_id": { $exists: true } },
          groupBy: "meta.site",
          aggregate: { all: "count", owned: { count: "answers.owner" }, first_id: { first: "answers.answer_id" } },
          sort: "meta.site",
        });
        expect(r.results).toEqual(expected);
      }
    });

    it("six group_by keys is an error naming the limit", async () => {
      const { projected } = await twin(legs.slice(0, 5) as unknown as Record<string, unknown>[]);
      await expect(query(projected, { groupBy: [...KEYS, "votes.vote"] })).rejects.toThrow(/at most 5 keys/);
    });
  });

  // ── 5. limit: 0 counts ────────────────────────────────────────────────────

  describe("limit: 0", () => {
    const docs = makeQuestions(300);

    it("returns total and no records, for records and aggregates, projected or not", async () => {
      const { projected, plain } = await twin(docs);
      const matching = docs.filter((d) => d.owner_user_id === 4);
      const groups = new Set(docs.flatMap((d) => d.answers.map((a) => a.is_accepted))).size;
      for (const slug of [projected, plain]) {
        const r = await query(slug, { filter: { owner_user_id: 4 }, fields: ["question_id"], limit: 0 });
        expect(r).toMatchObject({ records: [], total: matching.length, count: 0, limit: 0, has_more: false, next_offset: null });
        const a = await query(slug, { groupBy: "owner_user_id", aggregate: { n: "count" }, limit: 0 });
        expect(a).toMatchObject({ results: [], total: 17, count: 0, limit: 0, has_more: false, next_offset: null });
        const nested = await query(slug, { groupBy: "answers.is_accepted", perRecord: true, limit: 0 });
        expect(nested).toMatchObject({ results: [], count: 0, limit: 0 });
        expect(nested.total).toBe(docs.reduce((s, d) => s + new Set(d.answers.map((x) => x.is_accepted)).size, 0));
        expect(groups).toBe(2);
        const none = await query(slug, { filter: { owner_user_id: 999 }, limit: 0 });
        expect(none).toMatchObject({ records: [], total: 0, has_more: false, next_offset: null });
      }
    });

    it("a negative limit is an error", async () => {
      const { projected } = await twin(docs.slice(0, 10));
      await expect(query(projected, { limit: -5 })).rejects.toThrow(/0 or more/);
    });
  });

  // ── 6. a plain indexed equality filter under the default order ────────────

  describe("indexed equality with the default order", () => {
    it("filter on a projected field with limit 1 is served by the projection index, which carries the default order", async () => {
      const docs = makeQuestions(3000);
      const slug = await store("questions", docs);
      await analyze(slug);
      const id = (await collectionRow(slug)).id;
      const column = (await registry(slug)).projections.find((p) => p.field === "owner_user_id")!.column;
      const def = await testDb.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${`hc_${id}_${column}_idx`}`);
      // An expression index over the guarded cast of owner_user_id (no column), then the default order.
      expect((def.rows[0] as { indexdef: string }).indexdef).toMatch(/hc_safe_float8\(\(data -> 'owner_user_id'::text\)\)[\s\S]*END\), created_at DESC, id DESC\)$/);

      const matching = docs.filter((d) => d.owner_user_id === 4);
      const r = await query(slug, { filter: { owner_user_id: 4 }, fields: ["question_id"], limit: 1 });
      expect(r.indexed).toBe(true);
      expect(r.plan).toBe(`Index Scan using hc_${id}_${column}_idx`);
      expect(r.total).toBe(matching.length);
      // Newest first: same-batch rows share created_at, so the highest row id (the last stored) wins.
      expect((r.records![0].data as Question).question_id).toBe(matching.at(-1)!.question_id);

      // A range on the column and a sort on it still use the same index.
      const ranged = await query(slug, { filter: { owner_user_id: { $gte: 15 } }, sort: "-owner_user_id", limit: 3 });
      expect(ranged.indexed).toBe(true);
      expect(ranged.records!.map((x) => (x.data as Question).owner_user_id)).toEqual([16, 16, 16]);
    });
  });

  // ── 7. describe's distinct counts ─────────────────────────────────────────

  describe("describe distinct counts", () => {
    it("are exact over every record for a collection this size, not counted from a sample", async () => {
      const docs = makeQuestions(1200);
      const slug = await store("questions", docs);
      const described = ok(await collectionsSvc.describeCollection(slug, USER_ID)) as { fields: { name: string; distinctCount?: number; distinctCountEstimate?: number }[] };
      const field = (name: string) => described.fields.find((f) => f.name === name)!;
      expect(field("owner_user_id").distinctCount).toBe(17);
      expect(field("question_id").distinctCount).toBe(1200);
      expect(field("score").distinctCount).toBe(new Set(docs.map((d) => d.score)).size);
      expect(field("closed").distinctCount).toBe(1);
      // Arrays and objects have none.
      expect(field("answers").distinctCount).toBeUndefined();
      expect(field("meta").distinctCount).toBeUndefined();
      expect(described.fields.every((f) => f.distinctCountEstimate === undefined)).toBe(true);
    });

    it("lists every index that can serve a query, including the GIN on the documents, and each exists", async () => {
      const docs = makeQuestions(300);
      const slug = await store("questions", docs);
      const described = ok(await collectionsSvc.describeCollection(slug, USER_ID)) as { storage: { indexes: { index: string; field: string; kind: string; serves?: string }[] } };
      const names = described.storage.indexes.map((i) => i.index);
      const id = (await collectionRow(slug)).id;
      expect(names[0]).toBe(`hc_${id}_data_gin_idx`);
      expect(described.storage.indexes[0].serves).toMatch(/\{"tags": "hiking"\}/);
      expect(names).toContain(`hc_${id}_created_at_idx`);
      const reg = await registry(slug);
      expect(names.length).toBe(2 + reg.projections.length + reg.unwinds.reduce((n, u) => n + u.fields.length, 0));
      const existing = await testDb.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename LIKE ${`hc_${id}%`}`);
      const present = new Set((existing.rows as { indexname: string }[]).map((r) => r.indexname));
      for (const name of names) expect(present.has(name), name).toBe(true);
    });

    it("larger collections get pg_stats estimates for indexed fields, labelled as estimates", async () => {
      const docs = makeQuestions(1200);
      const slug = await store("questions", docs);
      await analyze(slug);
      const row = await collectionRow(slug);
      const { estimatedDistinctCounts } = await import("./rows");
      const estimates = await estimatedDistinctCounts(row.id, row.storage, ["owner_user_id", "question_id", "title", "answers"]);
      expect(estimates.owner_user_id).toBe(17);
      expect(estimates.question_id).toBe(1200);
      expect(estimates.answers).toBeUndefined();
    });
  });

  // ── 8. the store response says when a batch built indexes ─────────────────

  describe("store response storage note", () => {
    it("says which fields and arrays were queued for indexing, only on the batch that did it", async () => {
      thresholds(200);
      const docs = makeQuestions(150);
      const first = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection: "questions", records: docs.slice(0, 50), return: "summary" })) as Record<string, unknown>;
      expect(first.storage_note).toBeUndefined();
      const second = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection: "questions", records: docs.slice(50), return: "summary" })) as Record<string, unknown>;
      // The write only queues the builds; they run in the background after the response.
      expect(second.storage_note).toMatch(/^This batch queued indexes on fields .*'owner_user_id'.*, unwinding 'answers' into a queryable table .*\. Indexes are built in the background shortly after this write/);
      expect(second.summary).toContain(second.storage_note as string);
      expect(first.use).toBe(`Pass slug "${(first.collection as { slug: string }).slug}" to other tools for this collection; its name "Questions" works too.`);
      const third = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection: "questions", records: makeQuestions(3), return: "summary" })) as Record<string, unknown>;
      expect(third.storage_note).toBeUndefined();
      // Import passes it through too.
      thresholds(100);
      const imported = ok(await recordsSvc.importRecords(USER_ID, ORG_ID, { collection: "fresh", format: "json", content: JSON.stringify(makeQuestions(120)) })) as Record<string, unknown>;
      expect(imported.storage_note).toMatch(/This batch queued indexes on fields/);
    });
  });

  // ── round 2: null groups sort last in both directions and page like records ──

  describe("null groups and aggregate paging", () => {
    it("the group with no value sorts last ascending and descending, counts toward total, and offset pages reach it", async () => {
      const docs = makeQuestions(300);
      const { projected, plain } = await twin(docs);
      // Answers without an owner form the null group (k % 4 === 3).
      const owners = new Map<number | null, number>();
      for (const d of docs) for (const a of d.answers) owners.set(a.owner?.user_id ?? null, (owners.get(a.owner?.user_id ?? null) ?? 0) + 1);
      expect(owners.has(null)).toBe(true);
      const keys = [...owners.keys()].filter((k): k is number => k !== null).sort((a, b) => a - b);
      for (const slug of [projected, plain]) {
        for (const [sort, order] of [["answers.owner.user_id", keys], ["-answers.owner.user_id", [...keys].reverse()]] as const) {
          const seen: unknown[] = [];
          let offset = 0;
          for (let page = 0; page < 10; page++) {
            const r = await query(slug, { groupBy: "answers.owner.user_id", aggregate: { n: "count" }, sort, limit: 4, offset });
            expect(r.total).toBe(owners.size);
            seen.push(...r.results!.map((x) => x["answers.owner.user_id"]));
            if (!r.has_more) {
              expect(r.next_offset).toBeNull();
              break;
            }
            expect(r.next_offset).toBe(offset + 4);
            offset = r.next_offset as number;
          }
          expect(seen).toEqual([...order, null]);
        }
        // A page past the last group still reports the total.
        const past = await query(slug, { groupBy: "answers.owner.user_id", limit: 5, offset: 1000 });
        expect(past).toMatchObject({ results: [], total: owners.size, has_more: false, next_offset: null });
      }
    });
  });
});
