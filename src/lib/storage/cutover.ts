import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { applyInference, updateRegistry } from "./apply";
import { buildPendingIndexes, type BuildReport } from "./builder";
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
 *    its live documents as one batch, which queues projections and unwinds
 *    (pending, like any write). A collection whose inference failed is not
 *    stamped, so a re-run retries it. Then the builder (builder.ts) builds
 *    everything queued — in this run or left failed or pending by an
 *    earlier one — before the cutover returns; a failed build is reported
 *    and retried by a re-run or `npm run storage:build-indexes`.
 * 3. Only with dropRecords, and only once every collection is marked and
 *    its rows in `records` still match the mark (count, and a content md5
 *    over id, data, status and deleted_at): DROP TABLE records.
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

export type BuildResult = { slug: string; kind: string; key: string; state: "ready" | "failed"; ms: number; error?: string };

export type CutoverReport = {
  dryRun: boolean;
  recordsTable: "present" | "absent";
  copied: CopyResult[];
  copy_ms: number;
  inference: InferenceResult[];
  /** Background builds the cutover ran after inference (every collection with due work). */
  builds: BuildResult[];
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

/**
 * id-ordered md5 over each row's id, data, status and deleted_at (as epoch
 * seconds, so the session time zone never changes it): what --drop-records
 * compares against the cutover mark. '' for no rows.
 */
async function contentFingerprint(ex: Executor, source: ReturnType<typeof sql>, where: ReturnType<typeof sql>): Promise<string> {
  const result = await ex.execute(sql`
    SELECT coalesce(md5(string_agg(md5(concat_ws('|', id::text, data::text,
             coalesce(status, '\\N'), coalesce(extract(epoch FROM deleted_at)::text, '\\N'))), '' ORDER BY id)), '') AS row_md5
    FROM ${source} WHERE ${where}`);
  return (result.rows[0] as { row_md5: string }).row_md5;
}

/** Sorted md5 over the documents alone (what marks without row_md5 carry). */
async function dataFingerprint(ex: Executor, source: ReturnType<typeof sql>, where: ReturnType<typeof sql>): Promise<string> {
  return (await fingerprint(ex, source, where)).data_md5;
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

  // Over this collection's rows in `records` (not the new table, which may
  // also hold rows written by the new code): what the drop re-checks.
  const row_md5 = await contentFingerprint(tx, sql`records`, sql`collection_id = ${c.id}`);
  const mark: CutoverMark = { at: new Date().toISOString(), rows: copied.rows, data_md5: copied.data_md5, row_md5 };
  await tx.execute(sql`UPDATE collections SET storage = ${JSON.stringify({ ...next, cutover: mark })}::jsonb WHERE id = ${c.id}`);

  const copy_ms = Math.round(performance.now() - started);
  log(`  copied ${c.slug} (#${c.id}): ${c.rows} rows (${c.live} live) in ${copy_ms} ms, verified${warnings.length ? `; ${warnings.join("; ")}` : ""}`);
  return { id: c.id, slug: c.slug, status: c.rows > 0 ? "copied" : "empty", rows: c.rows, live: c.live, copy_ms, data_md5: copied.data_md5, warnings };
}

/**
 * ANALYZE and one inference batch over a copied collection, unless already
 * done. inferred_at is stamped only when inference succeeded, so a re-run
 * retries a failed one.
 */
async function inferCollection(id: number, slug: string, docLimit: number, log: (line: string) => void): Promise<InferenceResult | null> {
  const before = readRegistry((await db.execute(sql`SELECT storage FROM collections WHERE id = ${id}`)).rows[0]?.storage);
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
      console.error(`[storage] cutover inference failed for collection ${id}`, err);
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const inference_ms = Math.round(performance.now() - t);

  const known = new Set(before.projections.map(projectionKey));
  const projections = after.projections.filter((p) => !known.has(projectionKey(p)));
  const unwinds = after.unwinds.filter((u) => !before.unwinds.some((b) => b.path === u.path));

  if (!error) {
    // Under the registry row lock: inference rewrote the registry, keep its
    // result and stamp it.
    await updateRegistry(id, async (current) => {
      if (!current.cutover) return null;
      return { ...current, cutover: { ...current.cutover, inferred_at: new Date().toISOString() } };
    });
  }

  const result: InferenceResult = {
    id,
    slug,
    docs: docs.length,
    analyze_ms,
    inference_ms,
    projections: projections.map((p) => ({ field: p.field, type: p.type, reason: p.reason })),
    // rows: filled in once the builder has created and backfilled the child table (runCutover).
    unwinds: unwinds.map((u) => ({ path: u.path, fields: u.fields.map((f) => f.field), rows: 0, reason: u.reason })),
    ...(error ? { error } : {}),
  };
  const created = [
    ...result.projections.map((p) => `projection ${p.field} (${p.type})`),
    ...result.unwinds.map((u) => `unwind ${u.path}`),
  ];
  log(`  inferred ${slug} (#${id}) over ${docs.length} docs in ${analyze_ms + inference_ms} ms: ${created.length ? `queued ${created.join(", ")}` : "nothing to build"}${error ? `; FAILED: ${error} (not marked inferred; a re-run retries it)` : ""}`);
  return result;
}

/**
 * Check every collection is marked and `records` still holds exactly the
 * rows that were copied (count and content), then drop it.
 */
async function dropRecordsTable(log: (line: string) => void): Promise<boolean> {
  const rows = await listCollections();
  const problems: string[] = [];
  for (const c of rows) {
    const mark = readRegistry(c.storage).cutover;
    const where = sql`collection_id = ${c.id}`;
    if (!mark) problems.push(`${c.slug}: not copied`);
    else if (mark.rows !== c.rows) problems.push(`${c.slug}: records holds ${c.rows} rows, ${mark.rows} were copied`);
    else if (!(await collectionTableExists(db, c.id))) problems.push(`${c.slug}: ${collectionTableName(c.id)} is missing`);
    else if (typeof mark.row_md5 === "string") {
      if ((await contentFingerprint(db, sql`records`, where)) !== mark.row_md5) {
        problems.push(`${c.slug}: its rows in records (data, status or deleted_at) changed since they were copied`);
      }
    } else if (typeof mark.data_md5 === "string") {
      if ((await dataFingerprint(db, sql`records`, where)) !== mark.data_md5) {
        problems.push(`${c.slug}: its documents in records changed since they were copied`);
      }
    } else {
      problems.push(`${c.slug}: its cutover mark has no fingerprint to check; re-run the cutover first`);
    }
  }
  const orphans = (await db.execute(sql`
    SELECT count(*)::int AS n FROM records r WHERE NOT EXISTS (SELECT 1 FROM collections c WHERE c.id = r.collection_id)`)).rows[0] as { n: number };
  if (orphans.n > 0) problems.push(`${orphans.n} records rows belong to no collection`);
  if (problems.length > 0) {
    throw new CutoverError(`refusing to drop records (the table is kept):\n  ${problems.join("\n  ")}`);
  }
  await db.execute(sql`DROP TABLE records`);
  log("dropped table records");
  return true;
}

function describeBuilds(report: BuildReport, targets: CollectionRow[]): BuildResult[] {
  const slugs = new Map(targets.map((c) => [c.id, c.slug]));
  return report.collections.flatMap((c) => c.outcomes.map((o) => ({ slug: slugs.get(c.collectionId) ?? String(c.collectionId), ...o })));
}

export async function runCutover(options: CutoverOptions = {}): Promise<CutoverReport> {
  const log = options.log ?? (() => {});
  const dryRun = options.dryRun === true;
  const report: CutoverReport = { dryRun, recordsTable: "present", copied: [], copy_ms: 0, inference: [], builds: [], dropped: false };

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

  // Build what inference queued (and anything an earlier run left pending
  // or failed) before returning, so the script exits with every index
  // ready or a failure reported.
  log("building queued indexes and unwinds");
  const built = await buildPendingIndexes({ retryFailed: true, log });
  report.builds = describeBuilds(built, targets);
  for (const r of report.inference) {
    if (r.unwinds.length === 0) continue;
    const registry = readRegistry((await db.execute(sql`SELECT storage FROM collections WHERE id = ${r.id}`)).rows[0]?.storage);
    const ready = registry.unwinds.filter((u) => r.unwinds.some((x) => x.path === u.path) && (!u.build || u.build.state === "ready"));
    const counts = await childTableCounts(ready.map((u) => u.table));
    r.unwinds = r.unwinds.map((u) => ({ ...u, rows: counts[ready.find((x) => x.path === u.path)?.table ?? ""] ?? 0 }));
  }

  if (options.dropRecords) report.dropped = await dropRecordsTable(log);
  return report;
}
