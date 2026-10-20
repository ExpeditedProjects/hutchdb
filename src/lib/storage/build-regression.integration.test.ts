import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Regression for the stress test's articles collection (stress/RESULTS.md
// findings 1–2): a text-heavy collection crossing the projection threshold
// used to add stored generated columns inside the write; each ALTER TABLE
// rewrote the whole table, hit the request statement timeout, was recorded
// in failed_ddl, and the collection was left with no projections, so range
// filters on it timed out too.
//
// Here the app's statement timeout is cut to 100 ms (the 5 s of production
// scaled to a table this test can build in a second or two). The old
// mechanism still times out on this table under that limit; the write now
// succeeds quickly and only queues the projections, the builder (with its
// own, long timeout) makes them ready, and a range filter is then served by
// an index well within the limit.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;
const USER_ID = "regression-user";
const ORG_ID = "regression-org";
const ROWS = 2000;
const APP_STATEMENT_TIMEOUT_MS = "100";

describe.skipIf(!TEST_DB_URL)("threshold crossing on a text-heavy collection (stress finding 1)", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD", "HUTCH_DB_STATEMENT_TIMEOUT_MS"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    process.env.HUTCH_PROJECT_THRESHOLD = String(ROWS);
    process.env.HUTCH_UNWIND_THRESHOLD = "1000000";
    // Read when @/lib/db creates the app pool, below.
    process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS = APP_STATEMENT_TIMEOUT_MS;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });
    appPool = (await import("@/lib/db")).db.$client as Pool;

    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
    await testDb.insert(schema.user).values({ id: USER_ID, email: "regression@hutch.test", name: "Regression" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "regression", name: "Regression", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const article = (i: number) => ({
    title: `Article ${i}`,
    author: `author-${i % 20}`,
    topic: `topic-${i % 7}`,
    word_count: 1000 + i,
    published_at: `2026-${String(1 + (i % 12)).padStart(2, "0")}-15`,
    // Prose, like the real bodies: long text is never projected.
    body: `body of article ${i} ${"lorem ipsum ".repeat(50)}`,
  });

  it("the write succeeds fast and queues; the builder makes the projections ready; a range filter then uses them", async () => {
    const records = await import("@/lib/services/records");
    const { buildPendingIndexes } = await import("./builder");

    // The collection, then ROWS - 1 articles with ~32 KB bodies of hex
    // (barely compressible) written straight into its table.
    const first = await records.createRecords(USER_ID, ORG_ID, { collection: "articles", records: [article(0)], return: "summary" });
    const slug = (first as { collection: { slug: string } }).collection.slug;
    const [row] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    const table = `hc_${row.id}`;
    await testDb.execute(sql`
      INSERT INTO ${sql.identifier(table)} (data)
      SELECT jsonb_build_object(
        'title', 'Article ' || i, 'author', 'author-' || (i % 20), 'topic', 'topic-' || (i % 7),
        'word_count', 1000 + i, 'published_at', '2026-' || lpad((1 + i % 12)::text, 2, '0') || '-15',
        'body', (SELECT string_agg(md5(random()::text || i || g), '') FROM generate_series(1, 1000) g))
      FROM generate_series(1, ${ROWS - 1}) i`);

    // What the write used to do, under the same limit: the table rewrite of
    // ADD COLUMN ... GENERATED ALWAYS AS (...) STORED times out.
    const legacy = await testPool.connect();
    try {
      await legacy.query("BEGIN");
      await legacy.query(`SET LOCAL statement_timeout = ${APP_STATEMENT_TIMEOUT_MS}`);
      await expect(legacy.query("SELECT hc_add_projection($1, 'p_word_count', 'word_count', 'number')", [table])).rejects.toMatchObject({ code: "57014" });
    } finally {
      await legacy.query("ROLLBACK");
      legacy.release();
    }

    // The threshold-crossing write: fast, successful, and it says what it queued.
    const started = performance.now();
    const crossing = await records.createRecords(USER_ID, ORG_ID, { collection: slug, records: [article(ROWS), article(ROWS + 1)], return: "summary" });
    const elapsed = performance.now() - started;
    expect(crossing).toMatchObject({ count: 2, storage_note: expect.stringMatching(/^This batch queued indexes on fields .*'word_count'/) });
    expect(elapsed).toBeLessThan(2000);
    const { readRegistry } = await import("./registry");
    const storage = async () => readRegistry((await testDb.select().from(schema.collections).where(eq(schema.collections.id, row.id)))[0].storage);
    const queued = await storage();
    expect(queued.projections.map((p) => p.field).sort()).toEqual(["author", "published_at", "title", "topic", "word_count"]);
    expect(queued.projections.every((p) => p.build?.state === "pending")).toBe(true);

    // The builder runs with its own statement timeout (HUTCH_INDEX_BUILD_TIMEOUT_MS, 10 min by default).
    const report = await buildPendingIndexes({ collectionId: row.id });
    expect(report.failed).toBe(0);
    expect((await storage()).projections.every((p) => p.build?.state === "ready")).toBe(true);

    // A range filter and sort on word_count now read the index, inside the 100 ms limit.
    const result = await records.queryRecords(slug, USER_ID, { filter: { word_count: { $gte: 1000 + ROWS - 10 } }, sort: "-word_count", fields: ["title", "word_count"], limit: 5 });
    expect(result).toMatchObject({ total: 12, indexed: true, plan: expect.stringMatching(new RegExp(`using ${table}_p_word_count_idx`)) });
    expect((result as { records: { data: { word_count: number } }[] }).records.map((r) => r.data.word_count)).toEqual([3001, 3000, 2999, 2998, 2997]);
  }, 120_000);
});
