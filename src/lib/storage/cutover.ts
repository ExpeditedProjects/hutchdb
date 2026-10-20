import { db } from "@/lib/db";
import { collections } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { applyInference } from "./apply";
import { childTableCounts } from "./rows";
import { collectionTableExists, createCollectionTable, setUniqueKey } from "./ddl";
import { collectionTableName, ident, projectionKey, readRegistry, type CutoverMark, type StorageRegistry } from "./registry";

/**
 * One-shot move of an existing database from the old shared `records` table
 * into per-collection tables (`npm run storage:cutover`, see
 * scripts/storage-cutover.ts, which takes a pg_dump first).
 *
 * 1. Copy, in ONE transaction: for each collection, smallest first, create
 *    hc_<id>, INSERT ... SELECT its rows with ids, timestamps, status and
 *    deleted_at unchanged, set the id sequence past the copied ids, then
 *    verify row count and a sorted md5 over the documents (plus an id-ordered
 *    md5 over every column). Any mismatch rolls back every collection. A
 *    finished collection is marked in its storage registry (`cutover`), so a
 *    re-run skips it.
 * 2. Inference, per collection: ANALYZE, then the inference rules over all of
 *    its live documents as one batch; what it created is reported.
 * 3. Only with dropRecords, and only once every collection is marked and
 *    still matches its mark: DROP TABLE records.
 *
 * No write lock: it is meant for a quiet minute. A collection whose new
 * table already holds rows written by the new code before the cutover ran
 * stops the copy (those rows' ids would collide with the copied ones).
 */

export type CutoverOptions = {
  /** Run and verify the copy, then roll it back; no inference, no drop. */
  dryRun?: boolean;
  dropRecords?: boolean;
  log?: (line: string) => void;
  /** Most live documents per collection inference evaluates. */
  inferenceDocLimit?: number;
};

export type CopyResult = {
  id: number;
  slug: string;
  status: "copied" | "already done" | "empty";
  rows: number;
  live: number;
  copy_ms?: number;
  data_md5?: string;
  warnings: string[];
};

export type InferenceResult = {
  id: number;
  slug: string;
  docs: number;
  analyze_ms: number;
  inference_ms: number;
  projections: { field: string; type: string; reason: string }[];
  unwinds: { path: string; fields: string[]; rows: number; reason: string }[];
  error?: string;
};

export type CutoverReport = {
  dryRun: boolean;
  recordsTable: "present" | "absent";
  copied: CopyResult[];
  copy_ms: number;
  inference: InferenceResult[];
  dropped: boolean;
};

export class CutoverError extends Error {}

type CollectionRow = { id: number; slug: string; unique_key: unknown; storage: unknown; rows: number; live: number };

const DEFAULT_INFERENCE_DOC_LIMIT = 50_000;

export async function recordsTableExists(): Promise<boolean> {
  const result = await db.execute(sql`SELECT to_regclass('records') IS NOT NULL AS present`);
  return result.rows[0]?.present === true;
}

/** Every collection with its row counts in `records`, smallest first. */
async function listCollections(): Promise<CollectionRow[]> {
  const result = await db.execute(sql`
    SELECT c.id, c.slug, c.unique_key, c.storage,
           coalesce(r.rows, 0)::int AS rows, coalesce(r.live, 0)::int AS live
    FROM collections c
    LEFT JOIN (
      SELECT collection_id, count(*) AS rows, count(*) FILTER (WHERE deleted_at IS NULL) AS live
      FROM records GROUP BY collection_id
    ) r ON r.collection_id = c.id
    ORDER BY rows ASC, c.id ASC`);
  return result.rows as CollectionRow[];
}

type Executor = { execute(q: ReturnType<typeof sql>): Promise<{ rows: Record<string, unknown>[] }> };

/**
 * Row count, sorted md5 over the documents, and an id-ordered md5 over every
 * copied column, for `source` restricted by `where`.
 */
async function fingerprint(ex: Executor, source: ReturnType<typeof sql>, where: ReturnType<typeof sql>) {
  const result = await ex.execute(sql`
    SELECT count(*)::int AS rows,
           coalesce(md5(string_agg(md5(data::text), '' ORDER BY md5(data::text))), '') AS data_md5,
           coalesce(md5(string_agg(md5(concat_ws('|', id::text, data::text,
             coalesce(source, '\\N'), coalesce(status, '\\N'), coalesce(deleted_at::text, '\\N'),
             coalesce(created_at::text, '\\N'), coalesce(updated_at::text, '\\N'))), '' ORDER BY id)), '') AS row_md5
    FROM ${source} WHERE ${where}`);
  return result.rows[0] as { rows: number; data_md5: string; row_md5: string };
}

async function copyCollection(tx: Executor, c: CollectionRow, log: (line: string) => void): Promise<CopyResult> {
  const registry = readRegistry(c.storage);
  if (registry.cutover) {
    return { id: c.id, slug: c.slug, status: "already done", rows: registry.cutover.rows, live: c.live, warnings: [] };
  }
  const tableName = collectionTableName(c.id);
  const table = ident(tableName);
  const warnings: string[] = [];
  const started = performance.now();

  await createCollectionTable(tx, c.id);
  const existing = (await tx.execute(sql`SELECT count(*)::int AS n FROM ${table}`)).rows[0] as { n: number };
  if (existing.n > 0 && c.rows > 0) {
    throw new CutoverError(`${c.slug}: ${tableName} already holds ${existing.n} rows written since the new code was deployed, and \`records\` holds ${c.rows} more; their ids would collide. Move them by hand, then re-run.`);
  }

  let copied = { rows: 0, data_md5: "" };
  if (c.rows > 0) {
    await tx.execute(sql`
      INSERT INTO ${table} (id, data, source, status, deleted_at, created_at, updated_at)
      SELECT id, data, source, status, deleted_at, created_at, updated_at
      FROM records WHERE collection_id = ${c.id} ORDER BY id`);
    await tx.execute(sql`SELECT setval(pg_get_serial_sequence(${tableName}, 'id'), (SELECT max(id) FROM ${table}))`);

    const before = await fingerprint(tx, sql`records`, sql`collection_id = ${c.id}`);
    const after = await fingerprint(tx, table, sql`true`);
    if (before.rows !== after.rows || before.data_md5 !== after.data_md5 || before.row_md5 !== after.row_md5) {
      throw new CutoverError(`${c.slug}: verify failed (records ${before.rows} rows ${before.data_md5}/${before.row_md5}, ${tableName} ${after.rows} rows ${after.data_md5}/${after.row_md5})`);
    }
    copied = after;
  }

  const uniqueKey = Array.isArray(c.unique_key) ? (c.unique_key as string[]) : [];
  let next: StorageRegistry = registry;
  if (uniqueKey.length > 0) {
    // The old `records` table never enforced unique_key; a unique index would reject
    // existing duplicates. Leave it unset then (a later on_conflict store
    // reports the duplicates as a 409) and say so.
    const dupes = await tx.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM ${table} WHERE deleted_at IS NULL
        GROUP BY ${sql.join(uniqueKey.map((k) => sql`data->${k}::text`), sql`, `)}
        HAVING count(*) > 1 AND bool_and(${sql.join(uniqueKey.map((k) => sql`data ? ${k}::text`), sql` AND `)})
      ) d`);
    const groups = (dupes.rows[0] as { n: number }).n;
    if (groups > 0) {
      warnings.push(`unique_key [${uniqueKey.join(", ")}] has ${groups} duplicate group(s); its unique index was not created`);
    } else {
      await setUniqueKey(tx, c.id, uniqueKey);
      next = { ...next, unique_key: uniqueKey };
    }
  }

  const mark: CutoverMark = { at: new Date().toISOString(), rows: copied.rows, data_md5: copied.data_md5 };
  await tx.execute(sql`UPDATE collections SET storage = ${JSON.stringify({ ...next, cutover: mark })}::jsonb WHERE id = ${c.id}`);

  const copy_ms = Math.round(performance.now() - started);
  log(`  copied ${c.slug} (#${c.id}): ${c.rows} rows (${c.live} live) in ${copy_ms} ms, verified${warnings.length ? `; ${warnings.join("; ")}` : ""}`);
  return { id: c.id, slug: c.slug, status: c.rows > 0 ? "copied" : "empty", rows: c.rows, live: c.live, copy_ms, data_md5: copied.data_md5, warnings };
}

/** ANALYZE and one inference batch over a copied collection, unless already done. */
async function inferCollection(id: number, slug: string, docLimit: number, log: (line: string) => void): Promise<InferenceResult | null> {
  const [row] = await db.select({ storage: collections.storage }).from(collections).where(eq(collections.id, id));
  const before = readRegistry(row?.storage);
  if (!before.cutover || before.cutover.inferred_at) return null;
  const table = ident(collectionTableName(id));

  let t = performance.now();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    await tx.execute(sql`ANALYZE ${table}`);
  });
  const analyze_ms = Math.round(performance.now() - t);

  const docs = (await db.execute(sql`
    SELECT data FROM ${table}
    WHERE deleted_at IS NULL AND jsonb_typeof(data) = 'object'
    ORDER BY id LIMIT ${docLimit}`)).rows.map((r) => r.data as Record<string, unknown>);

  t = performance.now();
  let after = before;
  let error: string | undefined;
  if (docs.length > 0) {
    try {
      after = await applyInference({ id, storage: before }, docs);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const inference_ms = Math.round(performance.now() - t);

  const known = new Set(before.projections.map(projectionKey));
  const projections = after.projections.filter((p) => !known.has(projectionKey(p)));
  const unwinds = after.unwinds.filter((u) => !before.unwinds.some((b) => b.path === u.path));
  const counts = await childTableCounts(unwinds.map((u) => u.table));

  // Re-read: inference rewrote the registry; keep its result and stamp it.
  const [fresh] = await db.select({ storage: collections.storage }).from(collections).where(eq(collections.id, id));
  const current = readRegistry(fresh?.storage);
  await db.update(collections)
    .set({ storage: { ...current, cutover: { ...(current.cutover ?? before.cutover), inferred_at: new Date().toISOString() } } })
    .where(eq(collections.id, id));

  const result: InferenceResult = {
    id,
    slug,
    docs: docs.length,
    analyze_ms,
    inference_ms,
    projections: projections.map((p) => ({ field: p.field, type: p.type, reason: p.reason })),
    unwinds: unwinds.map((u) => ({ path: u.path, fields: u.fields.map((f) => f.field), rows: counts[u.table] ?? 0, reason: u.reason })),
    ...(error ? { error } : {}),
  };
  const created = [
    ...result.projections.map((p) => `projection ${p.field} (${p.type})`),
    ...result.unwinds.map((u) => `unwind ${u.path} -> ${u.rows} child rows`),
  ];
  log(`  inferred ${slug} (#${id}) over ${docs.length} docs in ${analyze_ms + inference_ms} ms: ${created.length ? created.join(", ") : "nothing created"}${error ? `; FAILED: ${error}` : ""}`);
  return result;
}

/**
 * Check every collection is marked and `records` still holds exactly the
 * rows that were copied, then drop it.
 */
async function dropRecordsTable(log: (line: string) => void): Promise<boolean> {
  const rows = await listCollections();
  const problems: string[] = [];
  for (const c of rows) {
    const mark = readRegistry(c.storage).cutover;
    if (!mark) problems.push(`${c.slug}: not copied`);
    else if (mark.rows !== c.rows) problems.push(`${c.slug}: records holds ${c.rows} rows, ${mark.rows} were copied`);
    else if (!(await collectionTableExists(db, c.id))) problems.push(`${c.slug}: ${collectionTableName(c.id)} is missing`);
  }
  const orphans = (await db.execute(sql`
    SELECT count(*)::int AS n FROM records r WHERE NOT EXISTS (SELECT 1 FROM collections c WHERE c.id = r.collection_id)`)).rows[0] as { n: number };
  if (orphans.n > 0) problems.push(`${orphans.n} records rows belong to no collection`);
  if (problems.length > 0) {
    throw new CutoverError(`refusing to drop records:\n  ${problems.join("\n  ")}`);
  }
  await db.execute(sql`DROP TABLE records`);
  log("dropped table records");
  return true;
}

export async function runCutover(options: CutoverOptions = {}): Promise<CutoverReport> {
  const log = options.log ?? (() => {});
  const dryRun = options.dryRun === true;
  const report: CutoverReport = { dryRun, recordsTable: "present", copied: [], copy_ms: 0, inference: [], dropped: false };

  if (!(await recordsTableExists())) {
    report.recordsTable = "absent";
    log("table records does not exist: nothing to copy");
    return report;
  }

  const targets = await listCollections();
  const todo = targets.filter((c) => !readRegistry(c.storage).cutover);
  log(`${targets.length} collections, ${targets.reduce((n, c) => n + c.rows, 0)} rows in records; ${todo.length} to copy${dryRun ? " (dry run: copied, verified, then rolled back)" : ""}`);

  const started = performance.now();
  const DRY_RUN_ROLLBACK = Symbol("dry run");
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = 0`);
      for (const c of targets) report.copied.push(await copyCollection(tx, c, log));
      if (dryRun) throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  report.copy_ms = Math.round(performance.now() - started);
  log(`copy phase: ${report.copy_ms} ms${dryRun ? ", rolled back" : ", committed"}`);
  if (dryRun) {
    if (options.dropRecords) log("--drop-records: skipped in a dry run (the copy was rolled back)");
    return report;
  }

  const docLimit = options.inferenceDocLimit ?? DEFAULT_INFERENCE_DOC_LIMIT;
  for (const c of targets) {
    const result = await inferCollection(c.id, c.slug, docLimit, log);
    if (result) report.inference.push(result);
  }

  if (options.dropRecords) report.dropped = await dropRecordsTable(log);
  return report;
}
