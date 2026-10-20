import { db } from "@/lib/db";
import { collections } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { isPlainObject } from "@/lib/validation";
import { addProjection, addUnwind, toTextArrayLiteral, type Executor } from "./ddl";
import type { Conn, DbTx } from "./lock";
import { arrayCandidates, inferDecisions, thresholdsFromEnv, type Thresholds } from "./inference";
import {
  collectionTableName,
  ident,
  projectionKey,
  projectionSegments,
  readRegistry,
  valueFitsType,
  type Projection,
  type StorageRegistry,
  type Unwind,
} from "./registry";

/**
 * Run inference for a batch that just landed in a layout='table' collection
 * and apply each decision in its own transaction, updating the registry as
 * it goes. Failures here must never fail the write that triggered them:
 * callers wrap this in try/catch and log.
 */
export async function applyInference(
  collection: { id: number; storage: unknown },
  docs: Record<string, unknown>[],
  thresholds: Thresholds = thresholdsFromEnv(),
): Promise<StorageRegistry> {
  const table = ident(collectionTableName(collection.id));
  let registry = await loadRegistry(collection.id);

  const [{ count }] = (await db.execute(sql`SELECT count(*)::int AS count FROM ${table} WHERE deleted_at IS NULL`)).rows as { count: number }[];
  const rowCount = count;

  // Element totals across the collection, only for paths this batch makes
  // candidates — one SQL aggregate per path instead of scanning in JS.
  const elementCounts: Record<string, number> = {};
  for (const candidate of arrayCandidates(docs)) {
    if (registry.unwinds.some((u) => u.path === candidate.path)) continue;
    const [{ total }] = (await db.execute(sql`
      SELECT coalesce(sum(jsonb_array_length(data->${candidate.path}::text)), 0)::int AS total
      FROM ${table}
      WHERE deleted_at IS NULL AND jsonb_typeof(data->${candidate.path}::text) = 'array'`)).rows as { total: number }[];
    elementCounts[candidate.path] = total;
  }

  const decisions = inferDecisions({ collectionId: collection.id, docs, registry, rowCount, elementCounts, thresholds });

  for (const unwind of decisions.unwinds) {
    registry = await applyUnwind(collection.id, unwind);
  }
  for (const projection of decisions.projections) {
    registry = await applyProjection(collection.id, projection);
  }

  registry = await bumpEvaluatedRows(collection.id, docs.length);
  return registry;
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
  mutate: (registry: StorageRegistry, tx: DbTx) => Promise<StorageRegistry | null>,
  conn: Conn = db,
): Promise<StorageRegistry> {
  return conn.transaction(async (tx) => {
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
  return updateRegistry(collectionId, async (registry, tx) => {
    if (registry.projections.some((p) => projectionKey(p) === projectionKey(projection))) return null;
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
 * another type at their field. Called after every table-layout write that
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
  return updateRegistry(collectionId, async (registry, tx) => {
    if (registry.unwinds.some((u) => u.path === unwind.path)) return null;
    // The trigger and backfill read the unwind from collections.storage, so
    // the registry row is written before the DDL runs (same transaction).
    const next = { ...registry, unwinds: [...registry.unwinds, unwind] };
    await tx.update(collections).set({ storage: next }).where(eq(collections.id, collectionId));
    await addUnwind(tx, collectionId, unwind);
    return next;
  });
}

async function bumpEvaluatedRows(collectionId: number, n: number): Promise<StorageRegistry> {
  return updateRegistry(collectionId, async (registry) => ({
    ...registry,
    evaluated_rows: registry.evaluated_rows + n,
  }));
}
