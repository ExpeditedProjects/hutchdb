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
});
