import { db } from "@/lib/db";
import { collections } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { isPlainObject } from "@/lib/validation";
import { addProjection, addUnwind, toTextArrayLiteral, type Executor } from "./ddl";
import { arrayCandidates, inferDecisions, pathsToCount, thresholdsFromEnv, type PendingUnwind, type Thresholds } from "./inference";
import {
  childTableName,
  collectionTableName,
  ident,
  projectionKey,
  projectionSegments,
  readRegistry,
  valueFitsType,
  type FailedDdl,
  type Projection,
  type StorageRegistry,
  type Unwind,
} from "./registry";

/**
 * How long a projection or unwind whose DDL failed is left alone before a
 * write tries it again, so a failing ALTER (a lock it can't get, a value
 * the cast rejects) doesn't run, and fail, on every write.
 */
export const DDL_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/** How long projection/unwind DDL waits for a lock on the collection table before failing. */
const DDL_LOCK_TIMEOUT = "2s";

export type ApplyOptions = {
  /** Retry failed DDL now instead of after DDL_RETRY_BACKOFF_MS (the cutover's re-run). */
  retryFailed?: boolean;
};

/**
 * Run inference for a batch that just landed in a collection
 * and apply each decision in its own transaction, updating the registry as
 * it goes. `docs` are the documents as stored (after a merge, the merged
 * documents). One failed decision never blocks the others or the
 * evaluated_rows count: a failure is logged, recorded in `failed_ddl`
 * (an unwind also gets a pending entry with a generic reason), and not
 * retried for DDL_RETRY_BACKOFF_MS. Failures here must never fail the
 * write that triggered them: callers wrap this in try/catch and log.
 */
export async function applyInference(
  collection: { id: number; storage: unknown },
  docs: Record<string, unknown>[],
  thresholds: Thresholds = thresholdsFromEnv(),
  options: ApplyOptions = {},
): Promise<StorageRegistry> {
  const table = ident(collectionTableName(collection.id));
  const now = Date.now();
  let registry = await loadRegistry(collection.id);

  const [{ count }] = (await db.execute(sql`SELECT count(*)::int AS count FROM ${table} WHERE deleted_at IS NULL`)).rows as { count: number }[];
  const rowCount = count;

  // Element totals across the collection, only for paths this batch makes
  // candidates — one SQL aggregate per path, a bounded number per batch.
  const candidates = arrayCandidates(docs);
  const elementCounts: Record<string, number> = {};
  for (const path of pathsToCount(candidates, registry)) {
    const [{ total }] = (await db.execute(sql`
      SELECT coalesce(sum(jsonb_array_length(data->${path}::text)), 0)::int AS total
      FROM ${table}
      WHERE deleted_at IS NULL AND jsonb_typeof(data->${path}::text) = 'array'`)).rows as { total: number }[];
    elementCounts[path] = total;
  }

  const decisions = inferDecisions({ collectionId: collection.id, docs, registry, rowCount, elementCounts, thresholds });
  const pending: PendingUnwind[] = [...decisions.pending];
  const backingOff = (kind: FailedDdl["kind"], key: string) => {
    if (options.retryFailed) return undefined;
    const failure = (registry.failed_ddl ?? []).find((f) => f.kind === kind && f.key === key);
    const at = failure ? Date.parse(failure.at) : NaN;
    return Number.isFinite(at) && now - at < DDL_RETRY_BACKOFF_MS ? failure : undefined;
  };

  for (const unwind of decisions.unwinds) {
    const failed = backingOff("unwind", unwind.path);
    if (failed) {
      pending.push({ path: unwind.path, reason: unwindFailedReason(unwind.path, failed.at) });
      continue;
    }
    try {
      registry = await applyUnwind(collection.id, unwind);
    } catch (err) {
      console.error(`[storage] unwind of '${unwind.path}' failed for collection ${collection.id}`, err);
      const at = new Date(now).toISOString();
      registry = await recordFailure(collection.id, { kind: "unwind", key: unwind.path, at });
      pending.push({ path: unwind.path, reason: unwindFailedReason(unwind.path, at) });
    }
  }
  for (const projection of decisions.projections) {
    if (backingOff("projection", projectionKey(projection))) continue;
    try {
      registry = await applyProjection(collection.id, projection);
    } catch (err) {
      console.error(`[storage] projection of '${projection.field}' failed for collection ${collection.id}`, err);
      registry = await recordFailure(collection.id, { kind: "projection", key: projectionKey(projection), at: new Date(now).toISOString() });
    }
  }

  const evaluated = new Set([...candidates.map((c) => c.path), ...pending.map((p) => p.path)]);
  registry = await finishBatch(collection.id, docs.length, evaluated, pending);
  return registry;
}

/** The pending reason for a failed unwind: generic, never driver or SQL text (that goes to the log). */
function unwindFailedReason(path: string, at: string): string {
  const retry = new Date(Date.parse(at) + DDL_RETRY_BACKOFF_MS).toISOString();
  return `unwinding '${path}' failed at ${at}; a write after ${retry} tries again.`;
}

/** Record (or refresh) a failed DDL attempt in the registry. */
async function recordFailure(collectionId: number, failure: FailedDdl): Promise<StorageRegistry> {
  return updateRegistry(collectionId, async (registry) => ({
    ...registry,
    failed_ddl: [...(registry.failed_ddl ?? []).filter((f) => !(f.kind === failure.kind && f.key === failure.key)), failure],
  }));
}

/** The registry without a failed_ddl entry for (kind, key), after that DDL succeeded. */
function clearFailure(registry: StorageRegistry, kind: FailedDdl["kind"], key: string): StorageRegistry {
  const rest = (registry.failed_ddl ?? []).filter((f) => !(f.kind === kind && f.key === key));
  const { failed_ddl: _old, ...without } = registry;
  return rest.length > 0 ? { ...without, failed_ddl: rest } : without;
}

async function loadRegistry(collectionId: number): Promise<StorageRegistry> {
  const [row] = await db.select({ storage: collections.storage }).from(collections).where(eq(collections.id, collectionId));
  return readRegistry(row?.storage);
}

/**
 * Lock the collection row, re-read the registry (another writer may have
 * created the same thing meanwhile), apply the mutation, and persist.
 */
export async function updateRegistry(
  collectionId: number,
  mutate: (registry: StorageRegistry, tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<StorageRegistry | null>,
): Promise<StorageRegistry> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ storage: collections.storage })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .for("update");
    const current = readRegistry(row?.storage);
    const next = await mutate(current, tx);
    if (!next) return current;
    await tx.update(collections).set({ storage: next }).where(eq(collections.id, collectionId));
    return next;
  });
}

async function applyProjection(collectionId: number, projection: Projection): Promise<StorageRegistry> {
  return updateRegistry(collectionId, async (current, tx) => {
    if (current.projections.some((p) => projectionKey(p) === projectionKey(projection))) return null;
    await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${DDL_LOCK_TIMEOUT}'`)}`);
    const registry = clearFailure(current, "projection", projectionKey(projection));
    const column = registry.projections.some((p) => p.column === projection.column)
      ? `${projection.column}_${registry.projections.length}`
      : projection.column;
    const entry: Projection = { ...projection, column };
    await addProjection(tx, collectionId, entry);
    const mixed = await hasMisfits(tx, collectionId, entry);
    return { ...registry, projections: [...registry.projections, { ...entry, ...(mixed ? { mixed: true } : {}) }] };
  });
}

/**
 * Whether any live row holds a value at the projection's field that the
 * column cannot carry (another JSON type, JSON null, a non-date string for
 * a date): the column is NULL there while the document is not.
 */
async function hasMisfits(ex: Executor, collectionId: number, projection: Projection): Promise<boolean> {
  const table = ident(collectionTableName(collectionId));
  const result = await ex.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${table}
      WHERE deleted_at IS NULL AND ${ident(projection.column)} IS NULL
        AND data #> ${toTextArrayLiteral(projectionSegments(projection))}::text[] IS NOT NULL
    ) AS mixed`);
  return result.rows[0]?.mixed === true;
}

function valueAt(doc: unknown, segments: string[]): unknown {
  let current: unknown = doc;
  for (const key of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Mark projections `mixed` when documents just written hold a value of
 * another type at their field. Called after every write that
 * carries documents; the flag is sticky (deletes never clear it), which
 * only costs index use, never correctness.
 */
export async function markMixedProjections(collectionId: number, docs: unknown[]): Promise<void> {
  // Fresh read: another writer may have added a projection since this
  // request loaded the collection.
  const registry = await loadRegistry(collectionId);
  const misfit = registry.projections.filter((p) => !p.mixed && docs.some((doc) => {
    const value = valueAt(doc, projectionSegments(p));
    return value !== undefined && !valueFitsType(p.type, value);
  }));
  if (misfit.length === 0) return;
  await setMixed(collectionId, new Set(misfit.map(projectionKey)));
}

/** After a bulk SQL rewrite of documents (transform), re-check every unmixed projection in SQL. */
export async function recheckMixedProjections(collectionId: number): Promise<void> {
  const registry = await loadRegistry(collectionId);
  const misfit = new Set<string>();
  for (const p of registry.projections) {
    if (!p.mixed && (await hasMisfits(db, collectionId, p))) misfit.add(projectionKey(p));
  }
  if (misfit.size > 0) await setMixed(collectionId, misfit);
}

async function setMixed(collectionId: number, keys: Set<string>): Promise<void> {
  await updateRegistry(collectionId, async (registry) => {
    if (!registry.projections.some((p) => !p.mixed && keys.has(projectionKey(p)))) return null;
    return {
      ...registry,
      projections: registry.projections.map((p) => (keys.has(projectionKey(p)) ? { ...p, mixed: true } : p)),
    };
  });
}

async function applyUnwind(collectionId: number, unwind: Unwind): Promise<StorageRegistry> {
  return updateRegistry(collectionId, async (current, tx) => {
    if (current.unwinds.some((u) => u.path === unwind.path)) return null;
    await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${DDL_LOCK_TIMEOUT}'`)}`);
    const registry = clearFailure(current, "unwind", unwind.path);
    // Another writer may have unwound a path whose table name this one
    // would collide with since inference picked it.
    const entry: Unwind = { ...unwind, table: childTableName(collectionId, unwind.path, registry) };
    // The trigger and backfill read the unwind from collections.storage, so
    // the registry row is written before the DDL runs (same transaction).
    const next = { ...registry, unwinds: [...registry.unwinds, entry] };
    await tx.update(collections).set({ storage: next }).where(eq(collections.id, collectionId));
    await addUnwind(tx, collectionId, entry);
    return next;
  });
}

/**
 * Count the batch in evaluated_rows and refresh pending_unwinds: entries
 * for the paths this batch evaluated are replaced, others kept, and any
 * path that is unwound now is dropped.
 */
async function finishBatch(collectionId: number, n: number, evaluated: Set<string>, pending: PendingUnwind[]): Promise<StorageRegistry> {
  return updateRegistry(collectionId, async (registry) => {
    const unwound = new Set(registry.unwinds.map((u) => u.path));
    const kept = (registry.pending_unwinds ?? []).filter((p) => !evaluated.has(p.path));
    const next = [...kept, ...pending].filter((p) => !unwound.has(p.path)).sort((a, b) => a.path.localeCompare(b.path));
    const { pending_unwinds: _old, ...rest } = registry;
    return { ...rest, evaluated_rows: registry.evaluated_rows + n, ...(next.length > 0 ? { pending_unwinds: next } : {}) };
  });
}
