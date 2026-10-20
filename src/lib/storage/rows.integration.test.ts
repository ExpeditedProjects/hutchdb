import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// The row helpers' optional `tx`: without one they run on the pool as
// before; with one (Hutch Cloud's quota transaction) their statements join
// it, commit with it and roll back with it, and the lock/measure options
// report what a write replaced.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;
const COLLECTION_ID = 9001;

type Rows = typeof import("./rows");
type Db = typeof import("@/lib/db").db;

class Abort extends Error {}

describe.skipIf(!TEST_DB_URL)("row helpers with and without a transaction", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let rows: Rows;
  let db: Db;
  const savedUrl = process.env.HUTCH_DATABASE_URL;

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    await migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
    rows = await import("./rows");
    db = (await import("@/lib/db")).db;
    appPool = db.$client as Pool;
  });

  beforeEach(async () => {
    const { createCollectionTable, dropCollectionTable, setUniqueKey } = await import("./ddl");
    await dropCollectionTable(testDb, COLLECTION_ID);
    await createCollectionTable(testDb, COLLECTION_ID);
    await setUniqueKey(testDb, COLLECTION_ID, ["k"]);
  });

  afterAll(async () => {
    const { dropCollectionTable } = await import("./ddl");
    await dropCollectionTable(testDb, COLLECTION_ID);
    await appPool?.end();
    await testPool?.end();
    if (savedUrl === undefined) delete process.env.HUTCH_DATABASE_URL;
    else process.env.HUTCH_DATABASE_URL = savedUrl;
  });

  async function live(): Promise<Record<string, unknown>[]> {
    const result = await testDb.execute(sql`SELECT data FROM ${sql.identifier(`hc_${COLLECTION_ID}`)} WHERE deleted_at IS NULL ORDER BY id`);
    return (result.rows as { data: Record<string, unknown> }[]).map((r) => r.data);
  }

  /** Runs `fn` in a transaction, then rolls it back. */
  async function rolledBack(fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>): Promise<void> {
    await expect(db.transaction(async (tx) => {
      await fn(tx);
      throw new Abort();
    })).rejects.toBeInstanceOf(Abort);
  }

  it("without tx: every helper writes on the pool", async () => {
    const [a] = await rows.insertRecords(COLLECTION_ID, [{ k: "a", n: 1 }]);
    const up = await rows.upsertRecords(COLLECTION_ID, [{ k: "a", n: 2 }, { k: "b", n: 1 }], ["k"], "replace");
    expect("results" in up && up.results.map((r) => r.action)).toEqual(["updated", "created"]);
    expect(await rows.updateRecordData(COLLECTION_ID, a.id, { k: "a", n: 3 })).toMatchObject({ data: { k: "a", n: 3 } });
    expect(await rows.setRecordStatus(COLLECTION_ID, a.id, "archived")).toMatchObject({ status: "archived" });
    const t = await rows.transformRows(COLLECTION_ID, { rename_fields: { n: "count" } });
    expect(t.touched).toHaveLength(2);
    expect(t.before).toBeUndefined();
    expect(await live()).toEqual([{ k: "a", count: 3 }, { k: "b", count: 1 }]);
    expect(await rows.softDeleteRecord(COLLECTION_ID, a.id)).toMatchObject({ id: a.id, data: { k: "a", count: 3 } });
    expect(await rows.softDeleteRecord(COLLECTION_ID, a.id)).toBeUndefined();
    expect(await rows.softDeleteAll(COLLECTION_ID)).toEqual({ count: 1 });
    expect(await live()).toEqual([]);
  });

  it("with tx: writes commit with the caller's transaction", async () => {
    await db.transaction(async (tx) => {
      await rows.insertRecords(COLLECTION_ID, [{ k: "a" }], "api", { tx });
      await rows.upsertRecords(COLLECTION_ID, [{ k: "b" }], ["k"], "replace", "api", { tx });
      // Not visible outside the transaction until it commits.
      expect(await live()).toEqual([]);
    });
    expect(await live()).toEqual([{ k: "a" }, { k: "b" }]);
  });

  it("with tx: every helper's writes roll back with the caller's transaction", async () => {
    const [a] = await rows.insertRecords(COLLECTION_ID, [{ k: "a", n: 1 }]);
    await rows.insertRecords(COLLECTION_ID, [{ k: "b", n: 1 }]);
    await rolledBack(async (tx) => {
      await rows.insertRecords(COLLECTION_ID, [{ k: "c" }], "api", { tx });
      await rows.upsertRecords(COLLECTION_ID, [{ k: "b", n: 9 }], ["k"], "merge", "api", { tx });
      await rows.updateRecordData(COLLECTION_ID, a.id, { k: "a", n: 9 }, { tx });
      await rows.setRecordStatus(COLLECTION_ID, a.id, "archived", { tx });
      await rows.transformRows(COLLECTION_ID, { set_field: { field: "x", value: 1 } }, { tx });
      await rows.softDeleteRecord(COLLECTION_ID, a.id, { tx });
      await rows.softDeleteAll(COLLECTION_ID, { tx });
    });
    expect(await live()).toEqual([{ k: "a", n: 1 }, { k: "b", n: 1 }]);
    const [row] = (await testDb.execute(sql`SELECT status FROM ${sql.identifier(`hc_${COLLECTION_ID}`)} WHERE id = ${a.id}`)).rows;
    expect(row.status).not.toBe("archived");
  });

  it("with tx: a refused 'error' upsert undoes only its own savepoint", async () => {
    await rows.insertRecords(COLLECTION_ID, [{ k: "a" }]);
    await db.transaction(async (tx) => {
      await rows.insertRecords(COLLECTION_ID, [{ k: "z" }], "api", { tx });
      expect(await rows.upsertRecords(COLLECTION_ID, [{ k: "b" }, { k: "a" }], ["k"], "error", "api", { tx })).toEqual({ conflict: true });
      expect(await rows.upsertRecords(COLLECTION_ID, [{ k: "c" }, { k: "a" }], ["k"], "error", "api", { tx, lock: true })).toEqual({ conflict: true });
    });
    expect(await live()).toEqual([{ k: "a" }, { k: "z" }]);
  });

  it("lock: reports the record each upsert replaced, and the locked match for a skip", async () => {
    await rows.insertRecords(COLLECTION_ID, [{ k: "a", n: 1 }, { k: "b", n: 1 }]);
    await db.transaction(async (tx) => {
      const replaced = await rows.upsertRecords(COLLECTION_ID, [{ k: "a", n: 2 }, { k: "c", n: 1 }], ["k"], "merge", "api", { tx, lock: true });
      if (!("results" in replaced)) throw new Error("conflict");
      expect(replaced.results.map((r) => [r.action, r.previous?.data])).toEqual([
        ["updated", { k: "a", n: 1 }],
        ["created", undefined],
      ]);
      const skipped = await rows.upsertRecords(COLLECTION_ID, [{ k: "b", n: 5 }], ["k"], "skip", "api", { tx, lock: true });
      expect("results" in skipped && skipped.results).toEqual([
        expect.objectContaining({ action: "skipped", record: expect.objectContaining({ data: { k: "b", n: 1 } }) }),
      ]);
    });
    expect(await live()).toEqual([{ k: "a", n: 2 }, { k: "b", n: 1 }, { k: "c", n: 1 }]);
  });

  it("lockRecord + updateRecordData: the prior state under a row lock, undefined for a missing id", async () => {
    const [a] = await rows.insertRecords(COLLECTION_ID, [{ k: "a", n: 1 }]);
    await db.transaction(async (tx) => {
      const before = await rows.lockRecord(COLLECTION_ID, a.id, { tx });
      expect(before).toMatchObject({ id: a.id, data: { k: "a", n: 1 } });
      const after = await rows.updateRecordData(COLLECTION_ID, a.id, { k: "a", n: 2 }, { tx });
      expect(after).toMatchObject({ data: { k: "a", n: 2 } });
      // Held until commit: another session can't take it.
      const other = await testPool.connect();
      try {
        await other.query("BEGIN");
        const probe = await other.query(`SELECT id FROM hc_${COLLECTION_ID} WHERE id = $1 FOR UPDATE SKIP LOCKED`, [a.id]);
        expect(probe.rows).toHaveLength(0);
        await other.query("ROLLBACK");
      } finally {
        other.release();
      }
      expect(await rows.lockRecord(COLLECTION_ID, 999999, { tx })).toBeUndefined();
    });
  });

  it("softDeleteAll returnData: the deleted records' data", async () => {
    await rows.insertRecords(COLLECTION_ID, [{ k: "a" }, { k: "b" }]);
    const result = await rows.softDeleteAll(COLLECTION_ID, { returnData: true });
    expect(result.count).toBe(2);
    expect(result.data).toEqual(expect.arrayContaining([{ k: "a" }, { k: "b" }]));
  });

  it("transformRows measure: locks the touchable records and reports before/after", async () => {
    await rows.insertRecords(COLLECTION_ID, [{ k: "a", old: 1 }, { k: "b" }, { k: "c", drop: "xxxxxxxx" }]);
    const result = await db.transaction((tx) => rows.transformRows(
      COLLECTION_ID,
      { rename_fields: { old: "new" }, remove_fields: ["drop"] },
      { tx, measure: true },
    ));
    expect(result.touched).toHaveLength(2);
    expect(result.before?.map((r) => r.data)).toEqual([{ k: "a", old: 1 }, { k: "c", drop: "xxxxxxxx" }]);
    expect(result.after?.map((r) => r.data).sort((x, y) => String((x as { k: string }).k).localeCompare((y as { k: string }).k)))
      .toEqual([{ k: "a", new: 1 }, { k: "c" }]);
    expect(await live()).toEqual([{ k: "a", new: 1 }, { k: "b" }, { k: "c" }]);

    const none = await rows.transformRows(COLLECTION_ID, { remove_fields: ["absent"] }, { measure: true });
    expect(none).toEqual({ touched: [], before: [], after: [] });
  });

  it("transformRows: a failing statement leaves none applied, inside a caller's tx too", async () => {
    await rows.insertRecords(COLLECTION_ID, [{ k: "a", n: 1 }]);
    const bad = sql`(t.data->>'k')::int = 1`; // 'a' is not an integer
    await expect(rows.transformRows(COLLECTION_ID, { remove_fields: ["n"], set_field: { field: "x", value: 1 }, setFilter: bad }))
      .rejects.toBeInstanceOf(rows.TransformStepError);
    expect(await live()).toEqual([{ k: "a", n: 1 }]);

    await db.transaction(async (tx) => {
      await rows.insertRecords(COLLECTION_ID, [{ k: "b" }], "api", { tx });
      await expect(rows.transformRows(COLLECTION_ID, { remove_fields: ["n"], set_field: { field: "x", value: 1 }, setFilter: bad }, { tx }))
        .rejects.toMatchObject({ step: "set_field" });
      // The savepoint rolled back; the caller's transaction is still usable.
      await rows.insertRecords(COLLECTION_ID, [{ k: "c" }], "api", { tx });
    });
    expect(await live()).toEqual([{ k: "a", n: 1 }, { k: "b" }, { k: "c" }]);
  });

  it("searchRecords ranks matches and runs inside a tx", async () => {
    await rows.insertRecords(COLLECTION_ID, [{ t: "otter" }, { t: "otter otter otter" }, { t: "seal" }]);
    const hits = await rows.searchRecords(COLLECTION_ID, "otter", 10);
    expect(hits.map((h) => (h.data as { t: string }).t)).toEqual(["otter otter otter", "otter"]);
    expect(hits[0].rank).toBeGreaterThan(hits[1].rank);
    await db.transaction(async (tx) => {
      await rows.insertRecords(COLLECTION_ID, [{ t: "sea otter" }], "api", { tx });
      expect(await rows.searchRecords(COLLECTION_ID, "otter", 10, { tx })).toHaveLength(3);
    });
  });
});
