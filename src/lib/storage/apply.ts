import { db } from "@/lib/db";
import { collections } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { isPlainObject } from "@/lib/validation";
import { type Executor } from "./ddl";
import { projectionValue, textArray } from "./expression";
import { arrayCandidates, inferDecisions, pathsToCount, thresholdsFromEnv, type PendingUnwind, type Thresholds } from "./inference";
import {
  childTableName,
  collectionTableName,
  ident,
  projectionKey,
  projectionSegments,
  readRegistry,
  valueFitsType,
  type IndexBuild,
  type Projection,
  type StorageRegistry,
} from "./registry";

/**
 * Table size (heap + TOAST, pg_table_size) at which a collection gets the
 * full-text search GIN. Unindexed search parses every document on every
 * query: the stress test measured roughly 25 MB of documents per second
 * (product-catalog: 75 MB in ~3 s), so 10 MB keeps an unindexed search
 * near 0.4 s, while a GIN over a smaller table would mostly add write cost
 * (every insert parses its document into the index) for little gain.
 * Measured in bytes, not rows: the cost of search follows the size of the
 * documents (17k tiny rows searched in 146 ms; 10k articles timed out).
 */
export const DEFAULT_SEARCH_INDEX_THRESHOLD_BYTES = 10 * 1024 * 1024;

export function searchIndexThresholdFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HUTCH_SEARCH_INDEX_THRESHOLD_BYTES);
  return env.HUTCH_SEARCH_INDEX_THRESHOLD_BYTES !== undefined && env.HUTCH_SEARCH_INDEX_THRESHOLD_BYTES !== "" && Number.isInteger(n) && n >= 0
    ? n
    : DEFAULT_SEARCH_INDEX_THRESHOLD_BYTES;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function pending(now: number): IndexBuild {
  return { state: "pending", at: new Date(now).toISOString() };
}

/**
 * Run inference for a batch that just landed in a collection and record
 * its decisions in the registry as pending builds: expression projections,
 * unwinds (child tables) and, once the table is large enough, the search
 * index. Nothing is built here — no DDL runs in the write; builder.ts
 * builds pending entries in the background (buildPendingIndexes), and the
 * compiler ignores them until they are ready. `docs` are the documents as
 * stored (after a merge, the merged documents). Failures here must never
 * fail the write that triggered them: callers wrap this in try/catch and
 * log.
 */
export async function applyInference(
  collection: { id: number; storage: unknown },
  docs: Record<string, unknown>[],
  thresholds: Thresholds = thresholdsFromEnv(),
  searchThresholdBytes: number = searchIndexThresholdFromEnv(),
): Promise<StorageRegistry> {
  const tableName = collectionTableName(collection.id);
  const table = ident(tableName);
  const now = Date.now();
  const registry = await loadRegistry(collection.id);

  const [{ count, bytes }] = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM ${table} WHERE deleted_at IS NULL) AS count,
           pg_table_size(${tableName}::regclass)::float8 AS bytes`)).rows as { count: number; bytes: number }[];
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
  const wantSearch = !registry.search_index && Number(bytes) >= searchThresholdBytes && rowCount > 0;
  const evaluated = new Set([...candidates.map((c) => c.path), ...decisions.pending.map((p) => p.path)]);

  return updateRegistry(collection.id, async (current) => {
    // Re-checked under the row lock: another writer may have queued the
    // same thing meanwhile.
    let next = current;
    for (const unwind of decisions.unwinds) {
      if (next.unwinds.some((u) => u.path === unwind.path)) continue;
      // Another writer may have unwound a path whose table name this one
      // would collide with since inference picked it.
      next = { ...next, unwinds: [...next.unwinds, { ...unwind, table: childTableName(collection.id, unwind.path, next), build: pending(now) }] };
    }
    for (const projection of decisions.projections) {
      if (next.projections.some((p) => projectionKey(p) === projectionKey(projection))) continue;
      const column = next.projections.some((p) => p.column === projection.column)
        ? `${projection.column}_${next.projections.length}`
        : projection.column;
      next = { ...next, projections: [...next.projections, { ...projection, column, kind: "expression", build: pending(now) }] };
    }
    if (wantSearch && !next.search_index) {
      next = {
        ...next,
        search_index: { build: pending(now), reason: `the collection's table reached ${formatBytes(Number(bytes))} (threshold ${formatBytes(searchThresholdBytes)}).` },
      };
    }
    return finishBatch(next, docs.length, evaluated, decisions.pending);
  });
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

/**
 * Whether any live row holds a value at the projection's field that the
 * column cannot carry (another JSON type, JSON null, a non-date string for
 * a date): the column is NULL there while the document is not.
 */
export async function hasMisfits(ex: Executor, collectionId: number, projection: Projection): Promise<boolean> {
  const table = ident(collectionTableName(collectionId));
  const result = await ex.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${table}
      WHERE deleted_at IS NULL AND ${projectionValue(projection)} IS NULL
        AND data #> ${textArray(projectionSegments(projection))}::text[] IS NOT NULL
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

/**
 * Count the batch in evaluated_rows and refresh pending_unwinds: entries
 * for the paths this batch evaluated are replaced, others kept, and any
 * path that is unwound (or queued to be) now is dropped.
 */
function finishBatch(registry: StorageRegistry, n: number, evaluated: Set<string>, pendingUnwinds: PendingUnwind[]): StorageRegistry {
  const unwound = new Set(registry.unwinds.map((u) => u.path));
  const kept = (registry.pending_unwinds ?? []).filter((p) => !evaluated.has(p.path));
  const next = [...kept, ...pendingUnwinds].filter((p) => !unwound.has(p.path)).sort((a, b) => a.path.localeCompare(b.path));
  const { pending_unwinds: _old, ...rest } = registry;
  return { ...rest, evaluated_rows: registry.evaluated_rows + n, ...(next.length > 0 ? { pending_unwinds: next } : {}) };
}
