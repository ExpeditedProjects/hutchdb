import { db, pool } from "@/lib/db";
import { envInt } from "@/lib/constants";
import { findPgError, formatTimeout } from "@/lib/db/errors";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";
import { hasMisfits, updateRegistry } from "./apply";
import { backfillUnwindRows, createUnwindTable, projectionIndexDdl, searchIndexDdl, type Executor } from "./ddl";
import {
  buildEntries,
  collectionTableName,
  ident,
  indexName,
  isDue,
  projectionKey,
  readRegistry,
  searchIndexName,
  type IndexBuild,
  type Projection,
  type StorageRegistry,
  type Unwind,
} from "./registry";

/**
 * Background builds for collection tables. Writes only queue work in the
 * registry (apply.ts: state "pending"); this module builds it outside any
 * request transaction:
 *
 * - expression projections and the search index: CREATE INDEX
 *   CONCURRENTLY (no table rewrite, no lock that blocks reads or writes),
 *   marked ready only once pg_index.indisvalid says the index is usable;
 * - unwinds: the child table and its sync triggers in one short
 *   transaction, then a batched backfill that never holds more than one
 *   batch of parent rows locked.
 *
 * One builder per collection at a time: each takes a session-level
 * pg_try_advisory_lock on (INDEX_BUILD_LOCK_CLASS, collection id) and skips
 * the collection when another holds it, so "building" seen while holding
 * the lock means a builder died mid-build: that attempt (counted when the
 * entry moved to building) is recorded as failed and retried after the
 * backoff. One builder loop per process (build-queue.ts) runs the builds
 * requests queue.
 * A failed build is recorded with a generic reason and retried after a
 * growing backoff; a CREATE INDEX CONCURRENTLY that fails leaves an INVALID
 * index behind, which is dropped before the entry is marked failed (and
 * again before any retry).
 *
 * Triggered after a write (or a read) that sees due work, via next/server
 * after() from the MCP route (build-queue.ts), by `npm run
 * storage:build-indexes`, and by the cutover before it exits.
 */

/** First key of the per-collection advisory lock ("HC" + 1). */
export const INDEX_BUILD_LOCK_CLASS = 0x48430001;
export const DEFAULT_INDEX_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a build waits for a table lock (CREATE INDEX CONCURRENTLY's own, the trigger DDL's) before it fails and backs off. */
export const DEFAULT_INDEX_BUILD_LOCK_TIMEOUT_MS = 5000;
/**
 * lock_timeout for CREATE/DROP INDEX CONCURRENTLY. Besides the table lock,
 * they wait for every transaction with an older snapshot — another
 * collection's build running at the same time, a slow query — and that wait
 * counts against lock_timeout too, so it gets longer than the trigger DDL's.
 */
export const DEFAULT_INDEX_BUILD_WAIT_MS = 60 * 1000;
/** First retry delay after a failed build; each further failure multiplies it by 4, up to MAX_RETRY_DELAY_MS. */
export const RETRY_BASE_MS = 60 * 1000;
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
/** Least statement timeout for dropping an INVALID index after a failed build. */
const CLEANUP_TIMEOUT_MS = 60 * 1000;
/** Parent ids per backfill statement. */
const BACKFILL_BATCH = 1000;
/** Rounds of retrying parent rows a writer held locked during the backfill, before the build fails. */
const BACKFILL_LOCKED_ROUNDS = 50;
const BACKFILL_LOCKED_WAIT_MS = 100;

export function buildLockTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return envInt("HUTCH_INDEX_BUILD_LOCK_TIMEOUT_MS", DEFAULT_INDEX_BUILD_LOCK_TIMEOUT_MS, { env });
}

export function buildWaitMs(env: Record<string, string | undefined> = process.env): number {
  return envInt("HUTCH_INDEX_BUILD_WAIT_MS", DEFAULT_INDEX_BUILD_WAIT_MS, { env });
}

export function buildTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return envInt("HUTCH_INDEX_BUILD_TIMEOUT_MS", DEFAULT_INDEX_BUILD_TIMEOUT_MS, { env });
}

/** A "building" entry older than this has no live builder (it would have timed out by now): due again. */
export function staleBuildingMs(env: Record<string, string | undefined> = process.env): number {
  return buildTimeoutMs(env) + 60 * 1000;
}

export function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_MS * 4 ** Math.max(0, attempts - 1));
}

export type BuildOptions = {
  /** Only this collection (else every collection with due work). */
  collectionId?: number;
  /** Start no new build after this long (one in flight finishes, bounded by its statement timeout). */
  budgetMs?: number;
  /**
   * A hard limit on the whole run, for builds in after() that the platform
   * stops at its function duration: no build starts after it, and each
   * build statement's timeout is the smaller of HUTCH_INDEX_BUILD_TIMEOUT_MS
   * and what is left of it. A build it cuts off fails with a reason that
   * says to run `npm run storage:build-indexes`. The CLI and the cutover
   * pass none and get the full build timeout.
   */
  platformBudgetMs?: number;
  /** Retry failed builds now, ignoring their backoff (CLI, cutover). */
  retryFailed?: boolean;
  log?: (line: string) => void;
};

export type BuildOutcome = { kind: "projection" | "unwind" | "search"; key: string; state: "ready" | "failed"; ms: number; error?: string };

export type CollectionBuildReport = { collectionId: number; skipped?: "locked"; outcomes: BuildOutcome[] };

export type BuildReport = { collections: CollectionBuildReport[]; failed: number };

const dialect = new PgDialect();

/** An Executor over one pg client, for statements that must run on the builder's session. */
function clientExecutor(client: PoolClient): Executor {
  return {
    async execute(query: SQL) {
      const { sql: text, params } = dialect.sqlToQuery(query);
      // No parameters: the simple protocol, which CREATE INDEX CONCURRENTLY needs (no implicit transaction).
      const result = params.length === 0 ? await client.query(text) : await client.query(text, params);
      return { rows: result.rows };
    },
  };
}

/**
 * Build whatever is due: pending entries, failed ones past their backoff
 * (or all failed ones with retryFailed), and building ones whose builder
 * died. Never throws for a failed build (it is recorded on the entry);
 * throws only when the builder itself can't run (no connection).
 */
export async function buildPendingIndexes(options: BuildOptions = {}): Promise<BuildReport> {
  const started = Date.now();
  const hardDeadline = options.platformBudgetMs !== undefined ? started + options.platformBudgetMs : undefined;
  const deadline = Math.min(started + (options.budgetMs ?? Number.POSITIVE_INFINITY), hardDeadline ?? Number.POSITIVE_INFINITY);
  const ids = options.collectionId !== undefined ? [options.collectionId] : await collectionsWithDueBuilds(options.retryFailed === true);
  const report: BuildReport = { collections: [], failed: 0 };
  for (const id of ids) {
    if (!timeToStart(deadline, hardDeadline)) break;
    const result = await buildCollection(id, deadline, hardDeadline, options);
    report.collections.push(result);
    report.failed += result.outcomes.filter((o) => o.state === "failed").length;
  }
  return report;
}

async function collectionsWithDueBuilds(retryFailed: boolean): Promise<number[]> {
  const rows = (await db.execute(sql`SELECT id, storage FROM collections ORDER BY id`)).rows as { id: number; storage: unknown }[];
  const now = Date.now();
  return rows.filter((r) => buildEntries(readRegistry(r.storage)).some((e) => isDue(e.build, now, { retryFailed, staleBuildingMs: 0 }))).map((r) => r.id);
}

async function loadRegistry(collectionId: number): Promise<StorageRegistry | null> {
  const row = (await db.execute(sql`SELECT storage FROM collections WHERE id = ${collectionId}`)).rows[0];
  return row ? readRegistry(row.storage) : null;
}

type Item =
  | { kind: "projection"; key: string; build: IndexBuild; projection: Projection }
  | { kind: "search"; key: string; build: IndexBuild }
  | { kind: "unwind"; key: string; build: IndexBuild; unwind: Unwind };

function dueItems(registry: StorageRegistry, retryFailed: boolean): Item[] {
  const now = Date.now();
  // Holding the lock, no one else is building: a "building" entry is stale.
  const due = (b: IndexBuild | undefined): b is IndexBuild => isDue(b, now, { retryFailed, staleBuildingMs: 0 });
  const items: Item[] = [];
  for (const p of registry.projections) if (p.kind === "expression" && due(p.build)) items.push({ kind: "projection", key: projectionKey(p), build: p.build, projection: p });
  if (registry.search_index && due(registry.search_index.build)) items.push({ kind: "search", key: "search", build: registry.search_index.build });
  for (const u of registry.unwinds) if (due(u.build)) items.push({ kind: "unwind", key: u.path, build: u.build, unwind: u });
  return items;
}

async function buildCollection(collectionId: number, deadline: number, hardDeadline: number | undefined, options: BuildOptions): Promise<CollectionBuildReport> {
  const report: CollectionBuildReport = { collectionId, outcomes: [] };
  const log = options.log ?? (() => {});
  const client = await pool.connect();
  // Whether this session holds the lock or changed its settings: then the
  // connection is destroyed on release instead of going back to the pool.
  let dirty = false;
  try {
    // The lock first, before any other work on the connection: a
    // collection another builder holds costs one round trip.
    const lock = await client.query("SELECT pg_try_advisory_lock($1::int, $2::int) AS ok", [INDEX_BUILD_LOCK_CLASS, collectionId]);
    if (lock.rows[0]?.ok !== true) {
      report.skipped = "locked";
      return report;
    }
    dirty = true;
    // Session settings for this builder only: the connection is destroyed
    // on release, so they never reach a pooled request connection.
    await client.query(`SET statement_timeout = ${statementLimit(hardDeadline).ms}`);
    await client.query(`SET lock_timeout = ${Math.trunc(buildLockTimeoutMs())}`);
    let registry = await loadRegistry(collectionId);
    if (!registry) return report;
    // Holding the lock, no one else is building: an entry left "building"
    // is a build that was interrupted (a restart, or the platform stopping
    // background work). It counts as a failed attempt and backs off.
    if (buildEntries(registry).some((e) => e.build?.state === "building")) {
      const { next, failed } = await failInterruptedBuilds(collectionId);
      registry = next;
      for (const e of failed) log(`  ${collectionTableName(collectionId)}: ${e.kind === "search" ? "search index" : `${e.kind} ${e.key}`} was left building by an interrupted build; failed, retry after ${e.retryAfter}`);
    }
    const ex = clientExecutor(client);
    let analyze = false;
    for (const item of dueItems(registry, options.retryFailed === true)) {
      if (!timeToStart(deadline, hardDeadline)) break;
      const started = Date.now();
      const outcome = await buildItem(ex, client, collectionId, item, hardDeadline);
      const ms = Date.now() - started;
      report.outcomes.push({ kind: item.kind, key: item.key, ms, ...outcome });
      log(`  ${collectionTableName(collectionId)}: ${item.kind === "search" ? "search index" : `${item.kind} ${item.key}`} ${outcome.state} in ${ms} ms${outcome.error ? ` (${outcome.error})` : ""}`);
      if (outcome.state === "ready" && item.kind !== "unwind") analyze = true;
    }
    if (analyze) {
      // Statistics for the new expressions, so the planner can estimate
      // (and choose) the new indexes before autovacuum gets to the table.
      try {
        await client.query(`SET statement_timeout = ${statementLimit(hardDeadline).ms}`);
        await client.query(`ANALYZE ${dialect.sqlToQuery(ident(collectionTableName(collectionId))).sql}`);
      } catch (err) {
        console.error(`[storage] ANALYZE after index builds failed for collection ${collectionId}`, err);
      }
    }
    return report;
  } finally {
    // Destroying the connection also releases the advisory lock and drops
    // the session settings; a session that never got the lock changed
    // nothing and goes back to the pool.
    client.release(dirty);
  }
}

/** Don't start a build with less than this left of a platform budget: it could only fail. */
const MIN_BUDGET_SLICE_MS = 1000;

function timeToStart(deadline: number, hardDeadline: number | undefined): boolean {
  const now = Date.now();
  return now < deadline && (hardDeadline === undefined || hardDeadline - now >= MIN_BUDGET_SLICE_MS);
}

/**
 * The statement timeout for the next build statement: the build timeout,
 * or what is left of the platform budget when that is less (`budget`).
 */
function statementLimit(hardDeadline: number | undefined): { ms: number; budget: boolean } {
  const full = Math.trunc(buildTimeoutMs());
  if (hardDeadline === undefined) return { ms: full, budget: false };
  const left = Math.max(1, Math.floor(hardDeadline - Date.now()));
  return left < full ? { ms: left, budget: true } : { ms: full, budget: false };
}

/** Reason recorded for an entry a builder found left "building" (see failInterruptedBuilds). */
export const INTERRUPTED_REASON = "the previous build was interrupted before it finished (a restart, or the platform stopping background work); if this repeats, run `npm run storage:build-indexes`";

/**
 * Turn every "building" entry into a failed attempt with backoff: called
 * while holding the collection's lock, when no builder can be at work on
 * it. The attempt was already counted when the entry moved to building.
 */
async function failInterruptedBuilds(collectionId: number): Promise<{ next: StorageRegistry; failed: { kind: string; key: string; retryAfter: string }[] }> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const fail = <E extends { build?: IndexBuild }>(entry: E): E => {
    if (entry.build?.state !== "building") return entry;
    const attempts = entry.build.attempts ?? 1;
    return { ...entry, build: { state: "failed", at, attempts, error: INTERRUPTED_REASON, retry_after: new Date(now + retryDelayMs(attempts)).toISOString() } };
  };
  let failed: { kind: string; key: string; retryAfter: string }[] = [];
  const next = await updateRegistry(collectionId, async (current) => {
    failed = buildEntries(current).filter((e) => e.build?.state === "building").map((e) => ({ kind: e.kind, key: e.key, retryAfter: new Date(now + retryDelayMs(e.build!.attempts ?? 1)).toISOString() }));
    if (failed.length === 0) return null;
    return {
      ...current,
      projections: current.projections.map(fail),
      unwinds: current.unwinds.map(fail),
      ...(current.search_index ? { search_index: fail(current.search_index) } : {}),
    };
  });
  return { next, failed };
}

async function buildItem(ex: Executor, client: PoolClient, collectionId: number, item: Item, hardDeadline: number | undefined): Promise<{ state: "ready" | "failed"; error?: string }> {
  // The attempt counts as soon as the entry is building: a build the
  // platform kills mid-way never reaches the failure path below, and the
  // next builder fails it (failInterruptedBuilds) with this count.
  const startedBuilding = await setBuild(collectionId, item, (prev) => ({ state: "building", at: new Date().toISOString(), attempts: (prev.attempts ?? 0) + 1 }));
  if (!startedBuilding) return { state: "failed", error: "the entry is gone from the registry" };
  const table = collectionTableName(collectionId);
  let index: string | null = null;
  const limits: StatementLimits = { hardDeadline, budgetBound: false };
  try {
    await applyStatementLimit(client, limits);
    let mixed = false;
    if (item.kind === "projection") {
      index = indexName(table, item.projection.column);
      const ddl = await projectionIndexDdl(db, collectionId, item.projection);
      await withIndexWait(client, async () => {
        await dropInvalidIndex(client, index!);
        await client.query(ddl);
      });
      await assertValidIndex(client, index);
      mixed = await hasMisfits(ex, collectionId, item.projection);
    } else if (item.kind === "search") {
      index = searchIndexName(table);
      await withIndexWait(client, async () => {
        await dropInvalidIndex(client, index!);
        await ex.execute(searchIndexDdl(collectionId));
      });
      await assertValidIndex(client, index);
    } else {
      await buildUnwind(ex, client, collectionId, item.unwind, limits);
    }
    await setBuild(collectionId, item, () => ({ state: "ready", at: new Date().toISOString() }), mixed);
    return { state: "ready" };
  } catch (err) {
    console.error(`[storage] building ${item.kind} ${item.key} failed for collection ${collectionId}`, err);
    if (index) {
      try {
        // Cleanup gets at least a minute even when the build's limit was tiny.
        await client.query(`SET statement_timeout = ${Math.max(buildTimeoutMs(), CLEANUP_TIMEOUT_MS)}`);
        await withIndexWait(client, () => dropInvalidIndex(client, index!));
      } catch (dropErr) {
        // The next attempt drops it first.
        console.error(`[storage] dropping invalid index ${index} failed`, dropErr);
      }
    }
    const error = genericReason(err, limits.budgetBound);
    await setBuild(collectionId, item, (prev) => {
      // Counted when the entry moved to building.
      const attempts = prev.state === "building" ? (prev.attempts ?? 1) : (prev.attempts ?? 0) + 1;
      const at = Date.now();
      return { state: "failed", at: new Date(at).toISOString(), attempts, error, retry_after: new Date(at + retryDelayMs(attempts)).toISOString() };
    });
    return { state: "failed", error };
  }
}

/**
 * Child table and triggers in one transaction, then the backfill in
 * batches up to the highest id that existed once the triggers did: every
 * later row was inserted by a statement that fired the insert trigger.
 */
async function buildUnwind(ex: Executor, client: PoolClient, collectionId: number, unwind: Unwind, limits: StatementLimits): Promise<void> {
  await client.query("BEGIN");
  try {
    await createUnwindTable(ex, collectionId, unwind);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
  const table = ident(collectionTableName(collectionId));
  const [{ max }] = (await ex.execute(sql`SELECT coalesce(max(id), 0)::int AS max FROM ${table}`)).rows as { max: number }[];
  for (let lo = 0; lo < max; lo += BACKFILL_BATCH) {
    const hi = Math.min(lo + BACKFILL_BATCH, max);
    // Each batch gets what is left of the platform budget, if less than the build timeout.
    await applyStatementLimit(client, limits);
    let skipped = await backfillUnwindRows(ex, collectionId, unwind, lo, hi, null);
    for (let round = 0; skipped.length > 0; round++) {
      if (round >= BACKFILL_LOCKED_ROUNDS) throw new BackfillLockedError();
      await new Promise((resolve) => setTimeout(resolve, BACKFILL_LOCKED_WAIT_MS));
      skipped = await backfillUnwindRows(ex, collectionId, unwind, lo, hi, skipped);
    }
  }
}

type StatementLimits = { hardDeadline: number | undefined; budgetBound: boolean };

/** SET statement_timeout for the next statement(s); throws BudgetSpentError once the platform budget is gone. */
async function applyStatementLimit(client: PoolClient, limits: StatementLimits): Promise<void> {
  if (limits.hardDeadline !== undefined && Date.now() >= limits.hardDeadline) {
    limits.budgetBound = true;
    throw new BudgetSpentError();
  }
  const limit = statementLimit(limits.hardDeadline);
  limits.budgetBound = limit.budget;
  await client.query(`SET statement_timeout = ${limit.ms}`);
}

class BudgetSpentError extends Error {
  constructor() {
    super("the platform budget for builds after a request ran out");
  }
}

class BackfillLockedError extends Error {
  constructor() {
    super("parent rows stayed locked by writes through every backfill retry");
  }
}

/**
 * Update one entry's build state under the registry row lock (fresh read:
 * writers may have changed other entries, or flagged this projection
 * mixed, meanwhile). `mixed` only ever sets the flag. False when the entry
 * is gone.
 */
async function setBuild(collectionId: number, item: Item, next: (prev: IndexBuild) => IndexBuild, mixed = false): Promise<boolean> {
  let found = false;
  await updateRegistry(collectionId, async (current) => {
    if (item.kind === "projection") {
      const i = current.projections.findIndex((p) => projectionKey(p) === item.key);
      if (i < 0) return null;
      found = true;
      const p = current.projections[i];
      const updated: Projection = { ...p, build: next(p.build ?? item.build), ...(mixed ? { mixed: true } : {}) };
      return { ...current, projections: current.projections.map((x, j) => (j === i ? updated : x)) };
    }
    if (item.kind === "search") {
      if (!current.search_index) return null;
      found = true;
      return { ...current, search_index: { ...current.search_index, build: next(current.search_index.build) } };
    }
    const i = current.unwinds.findIndex((u) => u.path === item.key);
    if (i < 0) return null;
    found = true;
    const u = current.unwinds[i];
    return { ...current, unwinds: current.unwinds.map((x, j) => (j === i ? { ...u, build: next(u.build ?? item.build) } : x)) };
  });
  return found;
}

async function indexValidity(client: PoolClient, index: string): Promise<boolean | null> {
  const r = await client.query(
    "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass($1::text)",
    [index],
  );
  return r.rows.length === 0 ? null : r.rows[0].valid === true;
}

/**
 * Run CREATE/DROP INDEX CONCURRENTLY under the longer buildWaitMs()
 * lock_timeout (see DEFAULT_INDEX_BUILD_WAIT_MS): with the short builder
 * lock_timeout, two collections building at once failed each other while
 * each waited for the other's snapshot. Waiting is cheap: the SHARE UPDATE
 * EXCLUSIVE lock they queue for conflicts with no read or write, so nothing
 * queues behind them. The trigger DDL of an unwind, which does block
 * writes, keeps the short lock_timeout.
 */
async function withIndexWait<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query(`SET lock_timeout = ${Math.trunc(buildWaitMs())}`);
  try {
    return await fn();
  } finally {
    await client.query(`SET lock_timeout = ${Math.trunc(buildLockTimeoutMs())}`);
  }
}

/** Drop an INVALID index left behind by a failed CREATE INDEX CONCURRENTLY. A valid one is kept. */
async function dropInvalidIndex(client: PoolClient, index: string): Promise<void> {
  if ((await indexValidity(client, index)) === false) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${dialect.sqlToQuery(ident(index)).sql}`);
  }
}

async function assertValidIndex(client: PoolClient, index: string): Promise<void> {
  if ((await indexValidity(client, index)) !== true) throw new Error(`index ${index} is missing or invalid after CREATE INDEX CONCURRENTLY`);
}

/** What describe shows for a failed build: never driver or SQL text. */
function genericReason(err: unknown, budgetBound = false): string {
  if (err instanceof BackfillLockedError) return "writes kept some records locked through every backfill retry";
  if (err instanceof BudgetSpentError || (budgetBound && findPgError(err)?.code === "57014")) {
    return "the build needed longer than background builds after a request may run (HUTCH_AFTER_BUILD_BUDGET_MS); run `npm run storage:build-indexes` to build it without that limit";
  }
  switch (findPgError(err)?.code) {
    case "57014": return `the build ran past its ${formatTimeout(buildTimeoutMs())} limit (HUTCH_INDEX_BUILD_TIMEOUT_MS)`;
    case "55P03": return "the build could not get a lock on the collection's table in time";
    case "40P01": return "the build was cancelled by a deadlock with a concurrent write";
    default: return "the build failed; the server log has the details";
  }
}
