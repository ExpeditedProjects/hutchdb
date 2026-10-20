import { db } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { collectionTableName, ident } from "./registry";

/**
 * Row operations on a layout='table' collection's hc_<id> table. Result
 * rows mirror the drizzle shape of the shared `records` table so service
 * responses look the same whichever layout a collection uses.
 */
export type TableRecord = {
  id: number;
  collectionId: number;
  data: unknown;
  source: string | null;
  status: string | null;
  deletedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

type RawRow = {
  id: number;
  data: unknown;
  source: string | null;
  status: string | null;
  deleted_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  inserted?: boolean;
};

export const RECORD_COLUMNS = sql`t.id, t.data, t.source, t.status, t.deleted_at, t.created_at, t.updated_at`;

/** drizzle's node-postgres driver leaves timestamps as strings on raw execute. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

export function toRecord(collectionId: number, row: RawRow): TableRecord {
  return {
    id: row.id,
    collectionId,
    data: row.data,
    source: row.source,
    status: row.status,
    deletedAt: toDate(row.deleted_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function table(collectionId: number): SQL {
  return ident(collectionTableName(collectionId));
}

/** Plain batch insert, one statement, rows returned in input order. */
export async function insertRecords(collectionId: number, docs: Record<string, unknown>[], source = "api"): Promise<TableRecord[]> {
  if (docs.length === 0) return [];
  const result = await db.execute(sql`
    INSERT INTO ${table(collectionId)} AS t (data, source)
    SELECT value, ${source}::text FROM jsonb_array_elements(${JSON.stringify(docs)}::jsonb)
    RETURNING ${RECORD_COLUMNS}`);
  return (result.rows as RawRow[]).map((r) => toRecord(collectionId, r));
}

export type UpsertMode = "replace" | "merge" | "skip" | "error";
export type UpsertResult =
  | { results: { action: "created" | "updated" | "skipped"; record: TableRecord | { data: Record<string, unknown> } }[] }
  | { conflict: true };

/**
 * Upsert over the table's unique key (uk_* columns + partial unique index,
 * see hc_set_unique_key). Documents missing any key field never conflict
 * and are inserted, as in the shared layout. Within one batch, later
 * documents with the same key win for 'replace', are shallow-merged over
 * earlier ones for 'merge', and lose for 'skip'. 'merge' updates an existing
 * row to `data || excluded.data`, the shared layout's {...old, ...new}.
 */
export async function upsertRecords(
  collectionId: number,
  docs: Record<string, unknown>[],
  keys: string[],
  mode: UpsertMode,
  source = "api",
): Promise<UpsertResult> {
  const keyOf = (doc: Record<string, unknown>): string | null =>
    keys.every((k) => doc[k] !== undefined) ? JSON.stringify(keys.map((k) => doc[k])) : null;

  const deduped: Record<string, unknown>[] = [];
  const seen = new Map<string, number>();
  for (const doc of docs) {
    const key = keyOf(doc);
    if (key === null) {
      deduped.push(doc);
      continue;
    }
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, deduped.length);
      deduped.push(doc);
    } else if (mode === "replace") {
      deduped[at] = doc;
    } else if (mode === "merge") {
      deduped[at] = { ...deduped[at], ...doc };
    }
  }

  const ukColumns = sql.join(keys.map((_, i) => ident(`uk_${i}`)), sql`, `);
  const conflictAction = mode === "replace"
    ? sql`DO UPDATE SET data = excluded.data, source = excluded.source, updated_at = now()`
    : mode === "merge"
      ? sql`DO UPDATE SET data = t.data || excluded.data, source = excluded.source, updated_at = now()`
      : sql`DO NOTHING`;

  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO ${table(collectionId)} AS t (data, source)
      SELECT value, ${source}::text FROM jsonb_array_elements(${JSON.stringify(deduped)}::jsonb)
      ON CONFLICT (${ukColumns}) WHERE deleted_at IS NULL ${conflictAction}
      RETURNING ${RECORD_COLUMNS}, (t.xmax = 0) AS inserted`);
    const rows = (result.rows as RawRow[]).map((r) => ({ record: toRecord(collectionId, r), inserted: r.inserted === true }));

    if (mode === "error" && rows.length < deduped.length) {
      tx.rollback();
    }

    const results: Extract<UpsertResult, { results: unknown }>["results"] = rows.map(({ record, inserted }) => ({
      action: inserted ? "created" : "updated",
      record,
    }));

    if (mode === "skip" && rows.length < deduped.length) {
      const landed = new Set(rows.map(({ record }) => keyOf(record.data as Record<string, unknown>)).filter((k) => k !== null));
      for (const doc of deduped) {
        const key = keyOf(doc);
        if (key === null || landed.has(key)) continue;
        const existing = await findByKey(tx, collectionId, keys, doc);
        results.push({ action: "skipped", record: existing ?? { data: doc } });
      }
    }
    return { results };
  }).catch((err: unknown) => {
    if (mode === "error" && isRollback(err)) return { conflict: true as const };
    throw err;
  });
}

function isRollback(err: unknown): boolean {
  return err instanceof Error && /rollback/i.test(err.message);
}

async function findByKey(
  ex: { execute(q: SQL): Promise<{ rows: Record<string, unknown>[] }> },
  collectionId: number,
  keys: string[],
  doc: Record<string, unknown>,
): Promise<TableRecord | undefined> {
  const conditions = keys.map((k, i) => sql`${ident(`uk_${i}`)} = ${JSON.stringify(doc[k])}::jsonb`);
  const result = await ex.execute(sql`
    SELECT ${RECORD_COLUMNS} FROM ${table(collectionId)} t
    WHERE ${sql.join(conditions, sql` AND `)} AND t.deleted_at IS NULL
    LIMIT 1`);
  const row = result.rows[0] as RawRow | undefined;
  return row ? toRecord(collectionId, row) : undefined;
}

export async function updateRecordData(collectionId: number, recordId: number, data: Record<string, unknown>): Promise<TableRecord | undefined> {
  const result = await db.execute(sql`
    UPDATE ${table(collectionId)} AS t SET data = ${JSON.stringify(data)}::jsonb, updated_at = now()
    WHERE t.id = ${recordId} AND t.deleted_at IS NULL
    RETURNING ${RECORD_COLUMNS}`);
  const row = result.rows[0] as RawRow | undefined;
  return row ? toRecord(collectionId, row) : undefined;
}

export async function setRecordStatus(collectionId: number, recordId: number, status: string): Promise<TableRecord | undefined> {
  const result = await db.execute(sql`
    UPDATE ${table(collectionId)} AS t SET status = ${status}::text, updated_at = now()
    WHERE t.id = ${recordId} AND t.deleted_at IS NULL
    RETURNING ${RECORD_COLUMNS}`);
  const row = result.rows[0] as RawRow | undefined;
  return row ? toRecord(collectionId, row) : undefined;
}

/** Soft delete; returns false when the record does not exist (or is already deleted). */
export async function softDeleteRecord(collectionId: number, recordId: number): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE ${table(collectionId)} SET deleted_at = now()
    WHERE id = ${recordId} AND deleted_at IS NULL
    RETURNING id`);
  return result.rows.length > 0;
}

export async function softDeleteAll(collectionId: number): Promise<void> {
  await db.execute(sql`UPDATE ${table(collectionId)} SET deleted_at = now() WHERE deleted_at IS NULL`);
}

export async function countRecords(collectionId: number): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS count FROM ${table(collectionId)} WHERE deleted_at IS NULL`);
  return (result.rows[0] as { count: number } | undefined)?.count ?? 0;
}

export async function lastRecordAt(collectionId: number): Promise<Date | null> {
  const result = await db.execute(sql`SELECT max(created_at) AS last_at FROM ${table(collectionId)} WHERE deleted_at IS NULL`);
  return toDate((result.rows[0] as { last_at: Date | string | null } | undefined)?.last_at);
}

export async function listRecords(collectionId: number, limit: number, offset: number): Promise<TableRecord[]> {
  const result = await db.execute(sql`
    SELECT ${RECORD_COLUMNS} FROM ${table(collectionId)} t
    WHERE t.deleted_at IS NULL
    ORDER BY t.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`);
  return (result.rows as RawRow[]).map((r) => toRecord(collectionId, r));
}

/** Fetch live parent documents by id (for attaching to child aggregates). */
export async function fetchRecordsByIds(collectionId: number, ids: number[]): Promise<TableRecord[]> {
  if (ids.length === 0) return [];
  const result = await db.execute(sql`
    SELECT ${RECORD_COLUMNS} FROM ${table(collectionId)} t
    WHERE t.id = ANY(${toIntArrayLiteral(ids)}::int[]) AND t.deleted_at IS NULL`);
  return (result.rows as RawRow[]).map((r) => toRecord(collectionId, r));
}

/**
 * Parent records for nested aggregate rows, slimmed in SQL: only the
 * requested top-level `fields`, or — without fields — only top-level
 * scalar values, so hundreds of large documents never leave Postgres.
 */
export async function fetchEmbeddedRecords(collectionId: number, ids: number[], fields: string[] | undefined): Promise<TableRecord[]> {
  if (ids.length === 0) return [];
  const keep = fields && fields.length > 0
    ? sql`kv.key = ANY(${toTextArrayLiteral(fields)}::text[])`
    : sql`jsonb_typeof(kv.value) IN ('string', 'number', 'boolean', 'null')`;
  const result = await db.execute(sql`
    SELECT t.id,
           coalesce((SELECT jsonb_object_agg(kv.key, kv.value) FROM jsonb_each(t.data) kv WHERE ${keep}), '{}'::jsonb) AS data,
           t.source, t.status, t.deleted_at, t.created_at, t.updated_at
    FROM ${table(collectionId)} t
    WHERE t.id = ANY(${toIntArrayLiteral(ids)}::int[]) AND t.deleted_at IS NULL`);
  return (result.rows as RawRow[]).map((r) => toRecord(collectionId, r));
}

function toTextArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

function toIntArrayLiteral(ids: number[]): string {
  return `{${ids.map((id) => Math.trunc(id)).join(",")}}`;
}

/** Full-text matches for hutch_search, same predicate as the shared layout. */
export async function searchRecords(collectionId: number, search: string, limit: number): Promise<TableRecord[]> {
  const result = await db.execute(sql`
    SELECT ${RECORD_COLUMNS} FROM ${table(collectionId)} t
    WHERE t.deleted_at IS NULL AND to_tsvector('english', t.data::text) @@ plainto_tsquery('english', ${search})
    LIMIT ${limit}`);
  return (result.rows as RawRow[]).map((r) => toRecord(collectionId, r));
}

/** Top-level keys of a few live documents, for hutch_list_collections. */
export async function sampleFieldNames(collectionId: number, limit: number): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT jsonb_object_keys(d.data) AS key
    FROM (SELECT data FROM ${table(collectionId)} WHERE deleted_at IS NULL AND jsonb_typeof(data) = 'object' LIMIT ${limit}) d`);
  return (result.rows as { key: string }[]).map((r) => r.key);
}

/** Sample documents for schema inference / describe. */
export async function sampleDocuments(collectionId: number, limit: number, random = false): Promise<Record<string, unknown>[]> {
  const order = random ? sql`ORDER BY random()` : sql``;
  const result = await db.execute(sql`
    SELECT data FROM ${table(collectionId)} WHERE deleted_at IS NULL ${order} LIMIT ${limit}`);
  return (result.rows as { data: Record<string, unknown> }[]).map((r) => r.data);
}

/** The three result sets getCollectionStats needs, same shapes as the shared layout. */
export async function collectionStats(collectionId: number, maxFields: number) {
  const t = table(collectionId);
  return Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS record_count,
             min(created_at)::text AS first_created_at,
             max(created_at)::text AS last_created_at,
             min(updated_at)::text AS first_updated_at,
             max(updated_at)::text AS last_updated_at,
             coalesce(sum(pg_column_size(data)), 0)::bigint AS approx_storage_bytes
      FROM ${t}
      WHERE deleted_at IS NULL`),
    db.execute(sql`
      SELECT status, count(*)::int AS count
      FROM ${t}
      WHERE deleted_at IS NULL
      GROUP BY status`),
    db.execute(sql`
      SELECT key, count(*)::int AS count
      FROM ${t}, LATERAL jsonb_object_keys(data) AS key
      WHERE deleted_at IS NULL AND jsonb_typeof(data) = 'object'
      GROUP BY key
      ORDER BY count DESC, key ASC
      LIMIT ${maxFields}`),
  ]);
}

/** Live row counts of each child table, for describe. */
export async function childTableCounts(tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of tables) {
    const result = await db.execute(sql`SELECT count(*)::int AS count FROM ${ident(name)}`);
    counts[name] = (result.rows[0] as { count: number } | undefined)?.count ?? 0;
  }
  return counts;
}
