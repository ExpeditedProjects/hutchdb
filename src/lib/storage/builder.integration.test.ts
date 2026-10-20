import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Background index builds against real Postgres (src/lib/storage/builder.ts):
// writes only queue projections, unwinds and the search index; the builder
// creates expression indexes with CREATE INDEX CONCURRENTLY (no new
// columns), the compiler emits the exact indexed expression so the planner
// uses it, nothing is used before it is ready (same answers either way),
// legacy generated-column projections keep working, concurrent builders
// and writers are safe, and failures leave no invalid index and back off.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "builder-user";
const ORG_ID = "builder-org";

type RecordsService = typeof import("@/lib/services/records");
type CollectionsService = typeof import("@/lib/services/collections");
type Builder = typeof import("./builder");

function ok<T>(result: T): Exclude<T, { error: unknown } | null | undefined> {
  if (result == null || (typeof result === "object" && "error" in (result as object))) {
    throw new Error(`Expected success result, got: ${JSON.stringify(result)}`);
  }
  return result as Exclude<T, { error: unknown } | null | undefined>;
}

type Doc = { n: number; score: number; name: string; day: string; flag: boolean; meta: { rank: number; label: string }; body: string };

const pad = (v: number) => String(v).padStart(2, "0");

function makeDocs(from: number, count: number): Doc[] {
  return Array.from({ length: count }, (_, k) => {
    const i = from + k;
    return {
      n: i,
      score: i % 97,
      name: `name-${i % 50}`,
      day: `2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}`,
      flag: i % 3 === 0,
      meta: { rank: i % 13, label: `L${i % 7}` },
      body: `entry ${i} about ${i % 10 === 0 ? "quokkas and zebras" : "nothing much"}`,
    };
  });
}

type QueryResult = Record<string, unknown> & { records?: { id: number; data: Doc }[]; total?: number; indexed: boolean; plan: string; reason?: string };

describe.skipIf(!TEST_DB_URL)("background index builds against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  let collectionsSvc: CollectionsService;
  let builder: Builder;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD", "HUTCH_SEARCH_INDEX_THRESHOLD_BYTES", "HUTCH_INDEX_BUILD_TIMEOUT_MS", "HUTCH_INDEX_BUILD_LOCK_TIMEOUT_MS", "HUTCH_INDEX_BUILD_WAIT_MS"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dialect = new PgDialect();

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });

    recordsSvc = await import("@/lib/services/records");
    collectionsSvc = await import("@/lib/services/collections");
    builder = await import("./builder");
    appPool = (await import("@/lib/db")).db.$client as Pool;

    await testDb.insert(schema.user).values({ id: USER_ID, email: "builder@hutch.test", name: "Builder" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "builder", name: "Builder", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    process.env.HUTCH_PROJECT_THRESHOLD = "100";
    process.env.HUTCH_UNWIND_THRESHOLD = "100";
    delete process.env.HUTCH_SEARCH_INDEX_THRESHOLD_BYTES;
    delete process.env.HUTCH_INDEX_BUILD_TIMEOUT_MS;
    delete process.env.HUTCH_INDEX_BUILD_LOCK_TIMEOUT_MS;
    delete process.env.HUTCH_INDEX_BUILD_WAIT_MS;
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

  async function storeMany(collection: string, docs: Record<string, unknown>[], batch = 1000): Promise<string> {
    let slug = collection;
    for (let i = 0; i < docs.length; i += batch) slug = await store(slug, docs.slice(i, i + batch));
    return slug;
  }

  async function collectionRow(slug: string) {
    const [row] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    return row;
  }

  async function registry(slug: string) {
    const { readRegistry } = await import("./registry");
    return readRegistry((await collectionRow(slug)).storage);
  }

  async function vacuumAnalyze(slug: string) {
    await testDb.execute(sql`VACUUM ANALYZE ${sql.identifier(`hc_${(await collectionRow(slug)).id}`)}`);
  }

  async function query(slug: string, params: Parameters<RecordsService["queryRecords"]>[2]): Promise<QueryResult> {
    return ok(await recordsSvc.queryRecords(slug, USER_ID, params)) as QueryResult;
  }

  async function indexState(name: string): Promise<"valid" | "invalid" | "missing"> {
    const r = await testDb.execute(sql`SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass(${name})`);
    if (r.rows.length === 0) return "missing";
    return (r.rows[0] as { valid: boolean }).valid ? "valid" : "invalid";
  }

  async function columnsOf(table: string): Promise<string[]> {
    const r = await testDb.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`);
    return (r.rows as { column_name: string }[]).map((x) => x.column_name);
  }

  /** Index names in the plan of a compiled query, with sequential scans priced out. */
  async function planIndexes(slug: string, params: Parameters<RecordsService["queryRecords"]>[2]): Promise<string[]> {
    const { compileQuery } = await import("./compiler");
    const row = await collectionRow(slug);
    const compiled = compileQuery({ id: row.id, storage: row.storage }, params);
    return explainIndexes(compiled.query);
  }

  async function explainIndexes(query: SQL, disable: string[] = ["enable_seqscan"]): Promise<string[]> {
    const { sql: text, params } = dialect.sqlToQuery(query);
    const client = await testPool.connect();
    try {
      await client.query("BEGIN");
      for (const setting of disable) await client.query(`SET LOCAL ${setting} = off`);
      const r = await client.query(`EXPLAIN (FORMAT JSON) ${text}`, params);
      const names: string[] = [];
      const walk = (node: { "Index Name"?: string; Plans?: unknown[] }) => {
        if (node["Index Name"]) names.push(node["Index Name"]);
        for (const child of node.Plans ?? []) walk(child as typeof node);
      };
      walk(r.rows[0]["QUERY PLAN"][0].Plan);
      return names;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  const ids = (r: QueryResult) => r.records!.map((x) => x.data.n);

  describe("writes only queue; the builder creates expression indexes", () => {
    it("a threshold-crossing write queues pending expression projections and builds nothing; the builder makes them ready without adding columns", async () => {
      const docs = makeDocs(0, 150);
      const slug = await store("events", docs);
      const id = (await collectionRow(slug)).id;
      const queued = await registry(slug);
      expect(queued.projections.map((p) => p.field).sort()).toEqual(["body", "day", "flag", "meta.label", "meta.rank", "n", "name", "score"]);
      for (const p of queued.projections) {
        expect(p.kind).toBe("expression");
        expect(p.build).toEqual({ state: "pending", at: expect.any(String) });
        expect(await indexState(`hc_${id}_${p.column}_idx`)).toBe("missing");
      }
      // The write ran no DDL: no columns, no indexes beyond the table's own.
      expect(await columnsOf(`hc_${id}`)).toEqual(["id", "data", "source", "status", "deleted_at", "created_at", "updated_at"]);

      // Queries ignore pending projections and give the documents' answer.
      const params = { filter: { score: { $gte: 90 } }, sort: "score", limit: 500 };
      const before = await query(slug, params);
      const expected = docs.filter((d) => d.score >= 90).sort((a, b) => a.score - b.score || a.n - b.n).map((d) => d.n);
      expect(ids(before)).toEqual(expected);
      expect(before.indexed).toBe(false);
      const described = ok(await collectionsSvc.describeCollection(slug, USER_ID)) as { storage: { indexes: { index: string; field: string; state: string }[] } };
      const projectionStates = (d: typeof described) => new Set(d.storage.indexes.filter((i) => i.index.includes("_p_")).map((i) => i.state));
      expect(projectionStates(described)).toEqual(new Set(["pending"]));
      expect(described.storage.indexes.find((i) => i.index === `hc_${id}_p_score_idx`)?.state).toBe("pending");

      const report = await builder.buildPendingIndexes();
      expect(report.failed).toBe(0);
      expect(report.collections.map((c) => [c.collectionId, c.outcomes.length])).toEqual([[id, 8]]);
      const built = await registry(slug);
      for (const p of built.projections) {
        expect(p.build).toEqual({ state: "ready", at: expect.any(String) });
        expect(await indexState(`hc_${id}_${p.column}_idx`)).toBe("valid");
      }
      expect(await columnsOf(`hc_${id}`)).toEqual(["id", "data", "source", "status", "deleted_at", "created_at", "updated_at"]);
      expect(ids(await query(slug, params))).toEqual(expected);
      // Nothing left to do.
      expect((await builder.buildPendingIndexes()).collections).toEqual([]);
      const after = ok(await collectionsSvc.describeCollection(slug, USER_ID)) as typeof described;
      expect(projectionStates(after)).toEqual(new Set(["ready"]));
    });

    it("the compiler emits the indexed expression for every type and nested paths, so the planner can use each index", async () => {
      const slug = await storeMany("typed", makeDocs(0, 3000));
      await builder.buildPendingIndexes();
      await vacuumAnalyze(slug);
      const id = (await collectionRow(slug)).id;
      const idx = (column: string) => `hc_${id}_${column}_idx`;
      const cases: [Parameters<RecordsService["queryRecords"]>[2], string][] = [
        [{ filter: { score: { $gte: 90, $lt: 95 } } }, idx("p_score")],
        [{ filter: { name: "name-7" } }, idx("p_name")],
        [{ filter: { day: { $gte: "2026-03-01", $lt: "2026-03-05" } } }, idx("p_day")],
        [{ filter: { flag: true } }, idx("p_flag")],
        [{ filter: { "meta.rank": { $gt: 11 } } }, idx("p_meta_rank")],
        [{ filter: { "meta.label": "L3" } }, idx("p_meta_label")],
        [{ filter: { body: "entry 7 about nothing much" } }, idx("p_body")],
        [{ sort: "-score", limit: 5 }, idx("p_score")],
        [{ sort: "meta.rank", limit: 5 }, idx("p_meta_rank")],
      ];
      for (const [params, index] of cases) {
        expect(await planIndexes(slug, params), JSON.stringify(params)).toContain(index);
      }
    });

    it("range filters and sorts on expression projections are served by their index, with the same answers as the documents", async () => {
      const docs = makeDocs(0, 3000);
      const slug = await storeMany("ranges", docs);
      await builder.buildPendingIndexes();
      await vacuumAnalyze(slug);
      const id = (await collectionRow(slug)).id;

      const range = await query(slug, { filter: { score: { $gte: 95 } }, sort: "score", limit: 1000 });
      expect(ids(range)).toEqual(docs.filter((d) => d.score >= 95).sort((a, b) => a.score - b.score || a.n - b.n).map((d) => d.n));
      expect(range.indexed).toBe(true);
      expect(range.plan).toMatch(new RegExp(`Index Scan using hc_${id}_p_score_idx$`));

      const desc = await query(slug, { sort: "-score", limit: 10 });
      expect(desc.records!.map((r) => r.data.score)).toEqual(Array(10).fill(96));
      expect(desc.indexed).toBe(true);
      expect(desc.plan).toMatch(new RegExp(`hc_${id}_p_score_idx`));

      const dates = await query(slug, { filter: { day: { $gte: "2026-12-27" } }, sort: "day", limit: 1000 });
      expect(dates.total).toBe(docs.filter((d) => d.day >= "2026-12-27").length);
      expect(dates.indexed).toBe(true);
      expect(dates.plan).toMatch(new RegExp(`hc_${id}_p_day_idx`));

      const nested = await query(slug, { filter: { "meta.rank": 12 }, sort: "-n", limit: 3 });
      expect(ids(nested)).toEqual(docs.filter((d) => d.meta.rank === 12).map((d) => d.n).sort((a, b) => b - a).slice(0, 3));
      expect(nested.indexed).toBe(true);
    });

    it("legacy generated-column projections keep working next to expression ones, and are never rebuilt", async () => {
      process.env.HUTCH_PROJECT_THRESHOLD = "100000";
      const docs = makeDocs(0, 3000);
      const slug = await storeMany("legacy", docs);
      const id = (await collectionRow(slug)).id;
      // What a write before background builds created: a stored generated column, its index, and a registry entry without kind or build.
      await testDb.execute(sql`SELECT hc_add_projection(${`hc_${id}`}, 'p_score', 'score', 'number')`);
      await testDb.execute(sql`CREATE INDEX ${sql.identifier(`hc_${id}_p_score_idx`)} ON ${sql.identifier(`hc_${id}`)} (p_score, created_at DESC, id DESC)`);
      await testDb.execute(sql`UPDATE collections SET storage = jsonb_set(storage, '{projections}', ${JSON.stringify([{ field: "score", column: "p_score", type: "number", reason: "legacy" }])}::jsonb) WHERE id = ${id}`);
      await vacuumAnalyze(slug);

      const r = await query(slug, { filter: { score: { $gte: 95 } }, sort: "score", limit: 1000 });
      expect(ids(r)).toEqual(docs.filter((d) => d.score >= 95).sort((a, b) => a.score - b.score || a.n - b.n).map((d) => d.n));
      expect(r.indexed).toBe(true);
      expect(r.plan).toMatch(new RegExp(`Index Scan using hc_${id}_p_score_idx$`));
      expect((await builder.buildPendingIndexes()).collections).toEqual([]);

      // A later threshold crossing queues only the new fields, as expressions.
      process.env.HUTCH_PROJECT_THRESHOLD = "100";
      await store(slug, makeDocs(3000, 10));
      const reg = await registry(slug);
      expect(reg.projections.find((p) => p.field === "score")).toEqual({ field: "score", column: "p_score", type: "number", reason: "legacy" });
      expect(reg.projections.filter((p) => p.field !== "score").every((p) => p.kind === "expression" && p.build?.state === "pending")).toBe(true);
      await builder.buildPendingIndexes();
      await vacuumAnalyze(slug);
      const both = await query(slug, { filter: { score: 96, name: { $in: ["name-1", "name-2"] } }, sort: "n", limit: 100 });
      expect(ids(both)).toEqual([...docs, ...makeDocs(3000, 10)].filter((d) => d.score === 96 && ["name-1", "name-2"].includes(d.name)).map((d) => d.n));
      const described = ok(await collectionsSvc.describeCollection(slug, USER_ID)) as { storage: { indexes: { field: string; state: string }[] } };
      expect(described.storage.indexes.find((i) => i.field === "score")?.state).toBe("ready");
    });
  });

  describe("concurrency", () => {
    it("a collection another builder holds is skipped and stays pending", async () => {
      const slug = await store("held", makeDocs(0, 150));
      const id = (await collectionRow(slug)).id;
      const holder = await testPool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1::int, $2::int)", [builder.INDEX_BUILD_LOCK_CLASS, id]);
        const report = await builder.buildPendingIndexes({ collectionId: id });
        expect(report.collections).toEqual([{ collectionId: id, skipped: "locked", outcomes: [] }]);
        expect((await registry(slug)).projections.every((p) => p.build?.state === "pending")).toBe(true);
      } finally {
        await holder.query("SELECT pg_advisory_unlock_all()");
        holder.release();
      }
      await builder.buildPendingIndexes({ collectionId: id });
      expect((await registry(slug)).projections.every((p) => p.build?.state === "ready")).toBe(true);
    });

    it("concurrent builders build each index once", async () => {
      const slug = await storeMany("racing", makeDocs(0, 2000));
      const id = (await collectionRow(slug)).id;
      const reports = await Promise.all([1, 2, 3].map(() => builder.buildPendingIndexes({ collectionId: id })));
      const outcomes = reports.flatMap((r) => r.collections.flatMap((c) => c.outcomes));
      expect(outcomes.every((o) => o.state === "ready")).toBe(true);
      expect(outcomes.map((o) => o.key).sort()).toEqual((await registry(slug)).projections.map((p) => JSON.stringify(p.path ?? [p.field])).sort());
      for (const c of reports.flatMap((r) => r.collections)) if (c.outcomes.length === 0) expect(c.skipped).toBe("locked");
      for (const p of (await registry(slug)).projections) expect(await indexState(`hc_${id}_${p.column}_idx`)).toBe("valid");
    });

    it("writes running during a build all land, and the built index answers for every one of them", async () => {
      const slug = await storeMany("busy", makeDocs(0, 2000));
      const id = (await collectionRow(slug)).id;
      const building = builder.buildPendingIndexes({ collectionId: id });
      const writes = Array.from({ length: 8 }, (_, w) => store(slug, makeDocs(2000 + w * 50, 50)));
      const [report] = await Promise.all([building, ...writes]);
      expect(report.failed).toBe(0);
      await vacuumAnalyze(slug);
      const all = makeDocs(0, 2400);
      const r = await query(slug, { filter: { score: { $gte: 95 } }, sort: "score", limit: 1000 });
      expect(r.indexed).toBe(true);
      // Concurrent batches get interleaved row ids, so ties on score come back in row order: compare as sets, and the order by score.
      expect(ids(r).sort((a, b) => a - b)).toEqual(all.filter((d) => d.score >= 95).map((d) => d.n));
      const scores = r.records!.map((x) => x.data.score);
      expect(scores).toEqual([...scores].sort((a, b) => a - b));
      // Every row is in the index: a count read through it (sequential and bitmap scans off) matches the table.
      const { projectionValue } = await import("./expression");
      const score = (await registry(slug)).projections.find((p) => p.field === "score")!;
      const throughIndex = sql`SELECT count(*)::int AS n FROM ${sql.identifier(`hc_${id}`)} WHERE ${projectionValue(score)} >= 0`;
      expect(await explainIndexes(throughIndex, ["enable_seqscan", "enable_bitmapscan"])).toEqual([`hc_${id}_p_score_idx`]);
      const client = await testPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        await client.query("SET LOCAL enable_bitmapscan = off");
        const { sql: text, params } = dialect.sqlToQuery(throughIndex);
        const through = (await client.query(text, params)).rows[0].n;
        const total = (await client.query(`SELECT count(*)::int AS n FROM hc_${id}`)).rows[0].n;
        expect(total).toBe(2400);
        expect(through).toBe(total);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  describe("failures", () => {
    it("an older open transaction makes the build wait for it, not fail, even past the lock timeout", async () => {
      const slug = await store("waits", makeDocs(0, 150));
      const id = (await collectionRow(slug)).id;
      process.env.HUTCH_INDEX_BUILD_LOCK_TIMEOUT_MS = "200";
      // CREATE INDEX CONCURRENTLY waits for every older snapshot (another
      // collection's build, a slow query); that wait must not hit lock_timeout.
      const blocker = await testPool.connect();
      let report;
      try {
        await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await blocker.query("SELECT 1");
        const building = builder.buildPendingIndexes({ collectionId: id });
        await new Promise((r) => setTimeout(r, 800));
        await blocker.query("ROLLBACK");
        report = await building;
      } finally {
        blocker.release();
      }
      expect(report.failed).toBe(0);
      for (const p of (await registry(slug)).projections) {
        expect(p.build?.state).toBe("ready");
        expect(await indexState(`hc_${id}_${p.column}_idx`)).toBe("valid");
      }
    });

    it("a build that fails after creating its index drops the INVALID index, records a generic reason with backoff, and a retry builds it", async () => {
      const slug = await store("fails", makeDocs(0, 150));
      const id = (await collectionRow(slug)).id;
      process.env.HUTCH_INDEX_BUILD_TIMEOUT_MS = "300";
      // An open snapshot older than the build: CREATE INDEX CONCURRENTLY
      // creates the index, then waits for it and gives up on the build's
      // statement timeout, leaving the index INVALID. DROP INDEX
      // CONCURRENTLY does not wait for it (it holds no lock on the table).
      const blocker = await testPool.connect();
      let report;
      try {
        await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await blocker.query("SELECT 1");
        report = await builder.buildPendingIndexes({ collectionId: id });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      delete process.env.HUTCH_INDEX_BUILD_TIMEOUT_MS;
      expect(report.failed).toBe(8);
      const reg = await registry(slug);
      for (const p of reg.projections) {
        expect(p.build).toMatchObject({ state: "failed", attempts: 1, error: "the build ran past its 300 ms limit (HUTCH_INDEX_BUILD_TIMEOUT_MS)" });
        const delay = Date.parse(p.build!.retry_after!) - Date.parse(p.build!.at);
        expect(delay).toBe(builder.RETRY_BASE_MS);
        expect(await indexState(`hc_${id}_${p.column}_idx`)).toBe("missing");
      }
      // Queries still answer from the documents.
      expect((await query(slug, { filter: { score: 3 } })).total).toBe(makeDocs(0, 150).filter((d) => d.score === 3).length);
      // Within the backoff, an automatic build leaves it alone.
      expect((await builder.buildPendingIndexes()).collections).toEqual([]);
      // An explicit retry builds it and clears the failure.
      const retried = await builder.buildPendingIndexes({ collectionId: id, retryFailed: true });
      expect(retried.failed).toBe(0);
      for (const p of (await registry(slug)).projections) {
        expect(p.build).toEqual({ state: "ready", at: expect.any(String) });
        expect(await indexState(`hc_${id}_${p.column}_idx`)).toBe("valid");
      }
    });

    it("a build past its statement timeout fails with a generic reason, and each further failure backs off longer", async () => {
      const slug = await store("slow", makeDocs(0, 150));
      const id = (await collectionRow(slug)).id;
      process.env.HUTCH_INDEX_BUILD_TIMEOUT_MS = "1";
      await builder.buildPendingIndexes({ collectionId: id });
      const first = (await registry(slug)).projections[0].build!;
      expect(first).toMatchObject({ state: "failed", attempts: 1, error: "the build ran past its 1 ms limit (HUTCH_INDEX_BUILD_TIMEOUT_MS)" });
      await builder.buildPendingIndexes({ collectionId: id, retryFailed: true });
      const second = (await registry(slug)).projections[0].build!;
      expect(second.attempts).toBe(2);
      expect(Date.parse(second.retry_after!) - Date.parse(second.at)).toBe(4 * builder.RETRY_BASE_MS);
      const leftovers = await testDb.execute(sql`SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid = to_regclass(${`hc_${id}`}) AND NOT indisvalid`);
      expect(leftovers.rows).toEqual([]);
      delete process.env.HUTCH_INDEX_BUILD_TIMEOUT_MS;
      await testDb.execute(sql`UPDATE collections SET storage = jsonb_set(storage, '{projections}', (SELECT jsonb_agg(jsonb_set(p, '{build,retry_after}', to_jsonb((now() - interval '1 second')::text))) FROM jsonb_array_elements(storage->'projections') p)) WHERE id = ${id}`);
      // Past the backoff, an automatic build retries.
      await builder.buildPendingIndexes();
      expect((await registry(slug)).projections.every((p) => p.build?.state === "ready")).toBe(true);
    });

    it("a build left 'building' by a builder that died is picked up again, whether or not its index got built", async () => {
      const slug = await store("orphan", makeDocs(0, 150));
      const id = (await collectionRow(slug)).id;
      const reg = await registry(slug);
      const [done, undone] = reg.projections;
      // The first one's index exists (the builder died after CREATE INDEX), the second's does not.
      const { projectionIndexDdl } = await import("./ddl");
      const { db } = await import("@/lib/db");
      await testDb.execute(sql.raw(await projectionIndexDdl(db, id, done)));
      const at = new Date(Date.now() - 1000).toISOString();
      await testDb.execute(sql`UPDATE collections SET storage = jsonb_set(storage, '{projections}', (SELECT jsonb_agg(jsonb_set(p, '{build}', jsonb_build_object('state', 'building', 'at', ${at}::text))) FROM jsonb_array_elements(storage->'projections') p)) WHERE id = ${id}`);
      const { queueDueIndexBuild, withIndexBuildQueue } = await import("./build-queue");
      // Not stale yet for a request (a builder might still be at work)...
      const row = rowRef(await collectionRow(slug));
      expect(withIndexBuildQueue(() => queueDueIndexBuild(row))).toBe(false);
      // ...but a builder that gets the lock knows no one else is building.
      const report = await builder.buildPendingIndexes();
      expect(report.failed).toBe(0);
      for (const p of [done, undone]) {
        expect((await registry(slug)).projections.find((x) => x.column === p.column)!.build!.state).toBe("ready");
        expect(await indexState(`hc_${id}_${p.column}_idx`)).toBe("valid");
      }
    });
  });

  describe("requests queue due builds", () => {
    it("a read of a collection with pending work queues it, and the drain builds it; a collection with nothing due queues nothing", async () => {
      const slug = await store("reads", makeDocs(0, 150));
      const { withIndexBuildQueue } = await import("./build-queue");
      await withIndexBuildQueue(async (drain) => {
        await query(slug, { filter: { score: 1 } });
        await drain();
      });
      expect((await registry(slug)).projections.every((p) => p.build?.state === "ready")).toBe(true);
      let drained = false;
      await withIndexBuildQueue(async (drain) => {
        await query(slug, { filter: { score: 1 } });
        const { queueDueIndexBuild } = await import("./build-queue");
        expect(queueDueIndexBuild(rowRef(await collectionRow(slug)))).toBe(false);
        await drain();
        drained = true;
      });
      expect(drained).toBe(true);
    });

    it("a write that queues work inside a request leaves it for the drain", async () => {
      const { withIndexBuildQueue } = await import("./build-queue");
      let slug = "";
      await withIndexBuildQueue(async (drain) => {
        slug = await store("writes", makeDocs(0, 150));
        expect((await registry(slug)).projections.every((p) => p.build?.state === "pending")).toBe(true);
        await drain();
      });
      expect((await registry(slug)).projections.every((p) => p.build?.state === "ready")).toBe(true);
    });
  });

  describe("full-text search index", () => {
    it("is queued once the table reaches the size threshold, and then serves search in hutch_query_records and hutch_search with the same results", async () => {
      process.env.HUTCH_PROJECT_THRESHOLD = "100000";
      const docs = makeDocs(0, 3000);
      const small = await store("small", makeDocs(0, 10));
      expect((await registry(small)).search_index).toBeUndefined();

      process.env.HUTCH_SEARCH_INDEX_THRESHOLD_BYTES = "65536";
      const slug = await storeMany("searchable", docs);
      const id = (await collectionRow(slug)).id;
      const queued = (await registry(slug)).search_index!;
      expect(queued).toEqual({ build: { state: "pending", at: expect.any(String) }, reason: expect.stringMatching(/^the collection's table reached \d+ KB \(threshold 64 KB\)\.$/) });
      // The small collection is still below it.
      await store(small, makeDocs(10, 1));
      expect((await registry(small)).search_index).toBeUndefined();

      const matching = docs.filter((d) => d.body.includes("quokkas")).map((d) => d.n).sort((a, b) => a - b);
      const before = await query(slug, { search: "quokka", sort: "n", limit: 1000 });
      expect(ids(before)).toEqual(matching);
      expect(before.indexed).toBe(false);
      const { searchRecords, searchRecordsQuery } = await import("./rows");
      const globalBefore = (await searchRecords(id, "zebras", 1000)).map((r) => (r.data as Doc).n).sort((a, b) => a - b);

      const report = await builder.buildPendingIndexes();
      expect(report.collections.find((c) => c.collectionId === id)!.outcomes.map((o) => [o.kind, o.state])).toEqual([["search", "ready"]]);
      expect(await indexState(`hc_${id}_search_idx`)).toBe("valid");
      expect((await registry(slug)).search_index!.build).toEqual({ state: "ready", at: expect.any(String) });
      await vacuumAnalyze(slug);

      const after = await query(slug, { search: "quokka", limit: 1000 });
      expect(after.records!.map((r) => r.data.n).sort((a, b) => a - b)).toEqual(matching);
      expect(after.indexed).toBe(true);
      expect(after.plan).toBe(`Bitmap Index Scan using hc_${id}_search_idx`);
      expect(await explainIndexes(searchRecordsQuery(id, "zebras", 10), [])).toContain(`hc_${id}_search_idx`);
      expect((await searchRecords(id, "zebras", 1000)).map((r) => (r.data as Doc).n).sort((a, b) => a - b)).toEqual(globalBefore);
      const global = ok(await recordsSvc.searchGlobal(USER_ID, "zebras", 50)) as { results: { collection: { slug: string }; records: unknown[] }[] };
      expect(global.results.reduce((n, g) => n + g.records.length, 0)).toBe(50);
      expect(global.results.some((g) => g.collection.slug === slug)).toBe(true);

      const described = ok(await collectionsSvc.describeCollection(slug, USER_ID)) as { storage: { indexes: { index: string; kind: string; state: string }[] } };
      expect(described.storage.indexes.find((i) => i.kind === "full-text search")?.state).toBe("ready");
      expect(described.storage.indexes.find((i) => i.index === `hc_${id}_search_idx`)?.state).toBe("ready");
    });
  });

  describe("unwinds are built in the background", () => {
    type Order = { key: number; items: { sku: string; qty: number }[] };
    const orders = (from: number, count: number): Order[] =>
      Array.from({ length: count }, (_, k) => {
        const i = from + k;
        return { key: i, items: Array.from({ length: 1 + (i % 3) }, (_, j) => ({ sku: `s${(i + j) % 20}`, qty: j + 1 })) };
      });

    async function childMatchesDocuments(id: number) {
      // Every live parent's elements, exactly, and nothing else.
      const r = await testDb.execute(sql`
        WITH expected AS (
          SELECT t.id AS parent_id, e.ord::int AS idx, e.val->>'sku' AS sku, (e.val->>'qty')::float8 AS qty
          FROM ${sql.identifier(`hc_${id}`)} t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.data->'items') = 'array' THEN t.data->'items' ELSE '[]' END) WITH ORDINALITY e(val, ord)
        ), actual AS (SELECT parent_id, idx, p_sku AS sku, p_qty AS qty FROM ${sql.identifier(`hc_${id}__items`)})
        SELECT (SELECT count(*)::int FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) a) AS missing,
               (SELECT count(*)::int FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected) b) AS extra,
               (SELECT count(*)::int FROM expected) AS total`);
      return r.rows[0] as { missing: number; extra: number; total: number };
    }

    it("the write queues the unwind without creating anything; queries answer from the documents until the builder has created and backfilled the child table", async () => {
      const docs = orders(0, 120);
      const slug = await store("orders", docs);
      const id = (await collectionRow(slug)).id;
      const reg = await registry(slug);
      expect(reg.unwinds.map((u) => [u.path, u.table, u.build?.state])).toEqual([["items", `hc_${id}__items`, "pending"]]);
      expect((await testDb.execute(sql`SELECT to_regclass(${`hc_${id}__items`}) IS NULL AS absent`)).rows[0]).toEqual({ absent: true });
      const filter = { "items.sku": "s3", "items.qty": 2 };
      const expected = docs.filter((d) => d.items.some((x) => x.sku === "s3" && x.qty === 2)).map((d) => d.key);
      const before = ok(await recordsSvc.queryRecords(slug, USER_ID, { filter, sort: "key", limit: 1000 })) as { records: { data: Order }[] };
      expect(before.records.map((r) => r.data.key)).toEqual(expected);

      await builder.buildPendingIndexes();
      expect((await registry(slug)).unwinds[0].build).toEqual({ state: "ready", at: expect.any(String) });
      expect(await childMatchesDocuments(id)).toEqual({ missing: 0, extra: 0, total: docs.reduce((n, d) => n + d.items.length, 0) });
      const after = ok(await recordsSvc.queryRecords(slug, USER_ID, { filter, sort: "key", limit: 1000 })) as { records: { data: Order }[] };
      expect(after.records.map((r) => r.data.key)).toEqual(expected);
      expect(await planIndexes(slug, { filter: { "items.sku": "s3" } })).toContain(`hc_${id}__items_p_sku_idx`);
    });

    it("the backfill stays exact while inserts, updates and transforms run during it", async () => {
      process.env.HUTCH_UNWIND_THRESHOLD = "100000";
      const slug = await storeMany("busy-orders", orders(0, 3000));
      const id = (await collectionRow(slug)).id;
      process.env.HUTCH_UNWIND_THRESHOLD = "100";
      await store(slug, orders(3000, 10));
      expect((await registry(slug)).unwinds[0]?.build?.state).toBe("pending");

      const building = builder.buildPendingIndexes({ collectionId: id });
      const writes = [
        ...Array.from({ length: 5 }, (_, w) => store(slug, orders(4000 + w * 20, 20))),
        recordsSvc.transformRecords(slug, USER_ID, { set_field: { field: "items", value: [{ sku: "moved", qty: 9 }], filter: { key: { $lt: 300 } } } }),
        ...Array.from({ length: 5 }, (_, w) => testDb.execute(sql`UPDATE ${sql.identifier(`hc_${id}`)} SET data = jsonb_set(data, '{items}', '[]') WHERE (data->>'key')::int % 500 = ${w}`)),
      ];
      const [report] = await Promise.all([building, ...writes]);
      expect(report.failed).toBe(0);
      expect((await registry(slug)).unwinds[0].build!.state).toBe("ready");
      const check = await childMatchesDocuments(id);
      expect(check).toMatchObject({ missing: 0, extra: 0 });
      expect(check.total).toBeGreaterThan(5000);
    }, 30_000);
  });
});

/** The collection row as the queue helpers take it. */
function rowRef(row: { id: number; storage: unknown }) {
  return { id: row.id, storage: row.storage };
}
