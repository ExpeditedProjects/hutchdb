import { db } from "@/lib/db";
import { sql, TransactionRollbackError, type SQL } from "drizzle-orm";
import { toTextArrayLiteral } from "./ddl";
import { collectionTableName, ident, indexName, readQueryRegistry } from "./registry";

/**
 * Row operations on a collection's hc_<id> table. Result rows are the
 * record shape services return (camelCase, with collectionId).
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

/**
 * Where a row helper runs: the shared pool (the default) or a drizzle
 * transaction opened from it. Hutch Cloud passes the transaction that
 * holds its storage-quota claim, so the write and the claim commit or roll
 * back together. Helpers that need several statements open a savepoint
 * inside a passed transaction (a transaction of their own on the pool), so
 * a refused upsert or a failed transform undoes only its own statements.
 */
export type RowExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Options every write helper takes; `tx` defaults to the shared pool. */
export type RowOptions = { tx?: RowExecutor };

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
export async function insertRecords(collectionId: number, docs: Record<string, unknown>[], source = "api", { tx = db }: RowOptions = {}): Promise<TableRecord[]> {
  if (docs.length === 0) return [];
  const result = await tx.execute(sql`
    INSERT INTO ${table(collectionId)} AS t (data, source)
    SELECT value, ${source}::text FROM jsonb_array_elements(${JSON.stringify(docs)}::jsonb)
    RETURNING ${RECORD_COLUMNS}`);
  return (result.rows as RawRow[]).map((r) => toRecord(collectionId, r));
}

export type UpsertMode = "replace" | "merge" | "skip" | "error";
export type UpsertResult =
  | {
      results: {
        action: "created" | "updated" | "skipped";
        record: TableRecord | { data: Record<string, unknown> };
        /** With `lock`: the live record an "updated" result replaced, as it was just before. */
        previous?: TableRecord;
      }[];
    }
  | { conflict: true };

export type UpsertOptions = RowOptions & {
  /**
   * Lock the live records the batch's keys match (SELECT ... FOR UPDATE)
   * before writing, and report each replaced record's prior state as
   * `previous` on its "updated" result. Cloud uses it to charge its
   * storage quota by exactly the bytes a write adds. A key inserted by a
   * concurrent writer after the lock read still upserts correctly; its
   * result just has no `previous`.
   */
  lock?: boolean;
};

/**
 * Upsert over the table's unique key (uk_* columns + partial unique index,
 * see hc_set_unique_key). Documents missing any key field never conflict
 * and are inserted. Within one batch, later
 * documents with the same key win for 'replace', are shallow-merged over
 * earlier ones for 'merge', lose for 'skip', and make 'error' a conflict.
 * 'merge' updates an existing row to `data || excluded.data`, i.e.
 * {...old, ...new}.
 */
export async function upsertRecords(
  collectionId: number,
  docs: Record<string, unknown>[],
  keys: string[],
  mode: UpsertMode,
  source = "api",
  { tx: ex = db, lock = false }: UpsertOptions = {},
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
    } else if (mode === "error") {
      // Two documents in one batch with the same key are a conflict. The
      // batch is one statement: nothing lands.
      return { conflict: true };
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

  const payload = JSON.stringify(deduped);
  return ex.transaction(async (tx) => {
    const before = new Map<number, TableRecord>();
    if (lock) {
      const matchColumns = sql.join(keys.map((_, i) => sql`t.${ident(`uk_${i}`)}`), sql`, `);
      const docKeys = sql.join(keys.map((k) => sql`d.value->${k}::text`), sql`, `);
      const locked = await tx.execute(sql`
        SELECT ${RECORD_COLUMNS} FROM ${table(collectionId)} t
        WHERE t.deleted_at IS NULL
          AND (${matchColumns}) IN (SELECT ${docKeys} FROM jsonb_array_elements(${payload}::jsonb) AS d)
        ORDER BY t.id
        FOR UPDATE OF t`);
      for (const r of locked.rows as RawRow[]) before.set(r.id, toRecord(collectionId, r));
      // 'error' refuses the whole batch when any key already exists.
      if (mode === "error" && before.size > 0) tx.rollback();
    }

    const result = await tx.execute(sql`
      INSERT INTO ${table(collectionId)} AS t (data, source)
      SELECT value, ${source}::text FROM jsonb_array_elements(${payload}::jsonb)
      ON CONFLICT (${ukColumns}) WHERE deleted_at IS NULL ${conflictAction}
      RETURNING ${RECORD_COLUMNS}, (t.xmax = 0) AS inserted`);
    const rows = (result.rows as RawRow[]).map((r) => ({ record: toRecord(collectionId, r), inserted: r.inserted === true }));

    if (mode === "error" && rows.length < deduped.length) {
      tx.rollback();
    }

    const results: Extract<UpsertResult, { results: unknown }>["results"] = rows.map(({ record, inserted }) => {
      const previous = inserted ? undefined : before.get(record.id);
      return { action: inserted ? "created" : "updated", record, ...(previous ? { previous } : {}) };
    });

    if (mode === "skip" && rows.length < deduped.length) {
      const landed = new Set(rows.map(({ record }) => keyOf(record.data as Record<string, unknown>)).filter((k) => k !== null));
      for (const doc of deduped) {
        const key = keyOf(doc);
        if (key === null || landed.has(key)) continue;
        const existing = [...before.values()].find((r) => keyOf(r.data as Record<string, unknown>) === key)
          ?? await findByKey(tx, collectionId, keys, doc);
        results.push({ action: "skipped", record: existing ?? { data: doc } });
      }
    }
    return { results };
  }).catch((err: unknown) => {
    if (mode === "error" && err instanceof TransactionRollbackError) return { conflict: true as const };
    throw err;
  });
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

/**
 * A live record locked for the rest of the caller's transaction (SELECT
 * ... FOR UPDATE), so its current state is what a following write in the
 * same transaction replaces. Undefined when no live record has that id.
 */
export async function lockRecord(collectionId: number, recordId: number, { tx = db }: RowOptions = {}): Promise<TableRecord | undefined> {
  const result = await tx.execute(sql`
    SELECT ${RECORD_COLUMNS} FROM ${table(collectionId)} t
    WHERE t.id = ${recordId} AND t.deleted_at IS NULL
    FOR UPDATE OF t`);
  const row = result.rows[0] as RawRow | undefined;
  return row ? toRecord(collectionId, row) : undefined;
}

export async function updateRecordData(collectionId: number, recordId: number, data: Record<string, unknown>, { tx = db }: RowOptions = {}): Promise<TableRecord | undefined> {
  const result = await tx.execute(sql`
    UPDATE ${table(collectionId)} AS t SET data = ${JSON.stringify(data)}::jsonb, updated_at = now()
    WHERE t.id = ${recordId} AND t.deleted_at IS NULL
    RETURNING ${RECORD_COLUMNS}`);
  const row = result.rows[0] as RawRow | undefined;
  return row ? toRecord(collectionId, row) : undefined;
}

export async function setRecordStatus(collectionId: number, recordId: number, status: string, { tx = db }: RowOptions = {}): Promise<TableRecord | undefined> {
  const result = await tx.execute(sql`
    UPDATE ${table(collectionId)} AS t SET status = ${status}::text, updated_at = now()
    WHERE t.id = ${recordId} AND t.deleted_at IS NULL
    RETURNING ${RECORD_COLUMNS}`);
  const row = result.rows[0] as RawRow | undefined;
  return row ? toRecord(collectionId, row) : undefined;
}

/**
 * Soft delete, guarded: the live→deleted transition happens at most once,
 * and returns the record as deleted (data included, so a caller can credit
 * its size exactly once). Undefined when the record does not exist or is
 * already deleted.
 */
export async function softDeleteRecord(collectionId: number, recordId: number, { tx = db }: RowOptions = {}): Promise<TableRecord | undefined> {
  const result = await tx.execute(sql`
    UPDATE ${table(collectionId)} AS t SET deleted_at = now()
    WHERE t.id = ${recordId} AND t.deleted_at IS NULL
    RETURNING ${RECORD_COLUMNS}`);
  const row = result.rows[0] as RawRow | undefined;
  return row ? toRecord(collectionId, row) : undefined;
}

/**
 * Soft-delete every live record. Returns how many; with `returnData`, also
 * each deleted record's data (Cloud credits their sizes to its quota).
 */
export async function softDeleteAll(
  collectionId: number,
  { tx = db, returnData = false }: RowOptions & { returnData?: boolean } = {},
): Promise<{ count: number; data?: unknown[] }> {
  const result = await tx.execute(sql`
    UPDATE ${table(collectionId)} SET deleted_at = now() WHERE deleted_at IS NULL
    RETURNING ${returnData ? sql`data` : sql`id`}`);
  const rows = result.rows as { data?: unknown }[];
  return returnData ? { count: rows.length, data: rows.map((r) => r.data) } : { count: rows.length };
}

export type TransformOps = {
  remove_fields?: string[];
  rename_fields?: Record<string, string>;
  set_field?: { field: string; value: unknown };
  /** Limits set_field to matching records (compileFilterWhere over alias `t`). */
  setFilter?: SQL;
};

export type TransformOptions = RowOptions & {
  /**
   * Lock every record an operation can touch before writing, confine the
   * writes to that snapshot (a record inserted meanwhile is never
   * rewritten), and report the touched records' data before and after.
   * Cloud uses it to charge its quota by the net growth.
   */
  measure?: boolean;
};

export type TransformRowsResult = {
  /** Distinct ids of the records changed. */
  touched: number[];
  /** With `measure`: every locked record's data before any operation. */
  before?: { id: number; data: unknown }[];
  /** With `measure`: each touched record's data after all operations. */
  after?: { id: number; data: unknown }[];
};

/** A transform statement failed; `step` names it. The statements already run are rolled back. */
export class TransformStepError extends Error {
  constructor(readonly step: string, readonly cause: unknown) {
    super(`transform ${step} failed`);
  }
}

/**
 * hutch_transform_records' statements: remove fields, then each rename,
 * then set_field. They run in one transaction (a savepoint inside a passed
 * `tx`), so a failure leaves none of them applied. Field names must already
 * be validated (FIELD_NAME_RE: letters, digits, underscore), since they go
 * into a Postgres array literal. Projection columns are generated from data
 * and the unwind triggers fire on data changes, so both stay in sync.
 */
export async function transformRows(
  collectionId: number,
  ops: TransformOps,
  { tx: ex = db, measure = false }: TransformOptions = {},
): Promise<TransformRowsResult> {
  const { remove_fields, set_field, setFilter } = ops;
  const renames = Object.entries(ops.rename_fields ?? {});
  const target = table(collectionId);
  const textArray = (names: string[]) => sql`${`{${names.join(",")}}`}::text[]`;

  return ex.transaction(async (tx) => {
    const step = async (name: string, query: SQL) => {
      try {
        return await tx.execute(query);
      } catch (err) {
        throw new TransformStepError(name, err);
      }
    };

    let scope = sql`t.deleted_at IS NULL`;
    let before: { id: number; data: unknown }[] | undefined;
    if (measure) {
      // A filter that only matches after a rename is covered by the rename
      // term; removals can only make the filter stop matching.
      const touchable = [
        ...(remove_fields?.length ? [sql`t.data ?| ${textArray(remove_fields)}`] : []),
        ...(renames.length ? [sql`t.data ?| ${textArray(renames.map(([oldName]) => oldName))}`] : []),
        ...(set_field ? [setFilter ? sql`(${setFilter})` : sql`TRUE`] : []),
      ];
      if (touchable.length === 0) return { touched: [], before: [], after: [] };
      const snapshot = await step("snapshot", sql`
        SELECT t.id, t.data FROM ${target} t
        WHERE t.deleted_at IS NULL AND (${sql.join(touchable, sql` OR `)})
        ORDER BY t.id
        FOR UPDATE OF t`);
      before = (snapshot.rows as { id: number; data: unknown }[]).map((r) => ({ id: Number(r.id), data: r.data }));
      if (before.length === 0) return { touched: [], before, after: [] };
      // One array bind param: drizzle expands a bare JS array into one
      // param per element, which breaks past Postgres' 65,535-param limit.
      scope = sql`t.id = ANY(${`{${before.map((r) => r.id).join(",")}}`}::integer[])`;
    }

    // Distinct ids, not summed row counts: one call can run several UPDATEs
    // over the same records (rename + remove + set).
    const touched = new Set<number>();
    const run = async (name: string, query: SQL) => {
      for (const row of (await step(name, query)).rows) touched.add(Number(row.id));
    };

    if (remove_fields?.length) {
      await run("remove_fields", sql`UPDATE ${target} AS t SET data = t.data - ${textArray(remove_fields)}, updated_at = now()
          WHERE ${scope} AND t.data ?| ${textArray(remove_fields)}
          RETURNING t.id`);
    }

    for (const [oldName, newName] of renames) {
      // Every ::text cast is load-bearing: `->` and `-` are overloaded on
      // (jsonb, text)/(jsonb, integer), and jsonb_build_object is VARIADIC
      // "any" — an untyped bind param in any of these makes Postgres reject
      // the statement ("could not determine data type of parameter").
      // Verified against node-postgres, which sends params untyped.
      await run("rename_fields", sql`UPDATE ${target} AS t
          SET data = (t.data || jsonb_build_object(${newName}::text, t.data->${oldName}::text)) - ${oldName}::text,
              updated_at = now()
          WHERE ${scope} AND t.data ? ${oldName}
          RETURNING t.id`);
    }

    if (set_field) {
      const overlay = JSON.stringify({ [set_field.field]: set_field.value });
      await run("set_field", sql`UPDATE ${target} AS t
          SET data = t.data || ${overlay}::jsonb,
              updated_at = now()
          WHERE ${scope} ${setFilter ? sql`AND (${setFilter})` : sql.empty()}
          RETURNING t.id`);
    }

    const ids = [...touched];
    if (!measure) return { touched: ids };
    if (ids.length === 0) return { touched: ids, before, after: [] };
    const after = await step("measure", sql`
      SELECT t.id, t.data FROM ${target} t
      WHERE t.id = ANY(${`{${ids.join(",")}}`}::integer[])`);
    return {
      touched: ids,
      before,
      after: (after.rows as { id: number; data: unknown }[]).map((r) => ({ id: Number(r.id), data: r.data })),
    };
  });
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

/**
 * Parent records for nested aggregate rows, slimmed in SQL: only the
 * given top-level keys (the caller projects paths below them), or —
 * without keys — only top-level scalar values (plus `extraKeys`), so
 * hundreds of large documents never leave Postgres.
 */
export async function fetchEmbeddedRecords(collectionId: number, ids: number[], keys: string[] | undefined, extraKeys: string[] = []): Promise<TableRecord[]> {
  if (ids.length === 0) return [];
  const keep = keys && keys.length > 0
    ? sql`kv.key = ANY(${toTextArrayLiteral(keys)}::text[])`
    : extraKeys.length > 0
      ? sql`(jsonb_typeof(kv.value) IN ('string', 'number', 'boolean', 'null') OR kv.key = ANY(${toTextArrayLiteral(extraKeys)}::text[]))`
      : sql`jsonb_typeof(kv.value) IN ('string', 'number', 'boolean', 'null')`;
  const result = await db.execute(sql`
    SELECT t.id,
           coalesce((SELECT jsonb_object_agg(kv.key, kv.value) FROM jsonb_each(t.data) kv WHERE ${keep}), '{}'::jsonb) AS data,
           t.source, t.status, t.deleted_at, t.created_at, t.updated_at
    FROM ${table(collectionId)} t
    WHERE t.id = ANY(${toIntArrayLiteral(ids)}::int[]) AND t.deleted_at IS NULL`);
  return (result.rows as RawRow[]).map((r) => toRecord(collectionId, r));
}

function toIntArrayLiteral(ids: number[]): string {
  return `{${ids.map((id) => Math.trunc(id)).join(",")}}`;
}

export type SearchMatch = TableRecord & { rank: number };

/**
 * Full-text matches for hutch_search, best first: by ts_rank, then newest.
 * `rank` lets matches from several collections be merged in one order.
 */
export async function searchRecords(collectionId: number, search: string, limit: number, { tx = db }: RowOptions = {}): Promise<SearchMatch[]> {
  const result = await tx.execute(sql`
    SELECT ${RECORD_COLUMNS}, m.rank FROM ${table(collectionId)} t,
      LATERAL (SELECT ts_rank(to_tsvector('english', t.data::text), plainto_tsquery('english', ${search}))::float8 AS rank) m
    WHERE t.deleted_at IS NULL AND to_tsvector('english', t.data::text) @@ plainto_tsquery('english', ${search})
    ORDER BY m.rank DESC, t.created_at DESC, t.id DESC
    LIMIT ${limit}`);
  return (result.rows as (RawRow & { rank: number | string })[]).map((r) => ({ ...toRecord(collectionId, r), rank: Number(r.rank) }));
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

/** The three result sets getCollectionStats needs. */
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

/**
 * Live record count and newest created_at for several collections in one
 * round trip (a UNION ALL over their tables). A collection whose table does
 * not exist yet counts as empty.
 */
export async function recordCounts(collectionIds: number[]): Promise<Map<number, { count: number; lastAt: Date | null }>> {
  const counts = new Map<number, { count: number; lastAt: Date | null }>();
  for (const id of collectionIds) counts.set(id, { count: 0, lastAt: null });
  if (collectionIds.length === 0) return counts;
  const present = await db.execute(sql`
    SELECT id FROM unnest(${toIntArrayLiteral(collectionIds)}::int[]) AS id
    WHERE to_regclass('hc_' || id) IS NOT NULL`);
  const ids = (present.rows as { id: number }[]).map((r) => r.id);
  if (ids.length === 0) return counts;
  const parts = ids.map((id) => sql`SELECT ${id}::int AS id, count(*)::int AS count, max(created_at) AS last_at FROM ${table(id)} WHERE deleted_at IS NULL`);
  const result = await db.execute(sql.join(parts, sql` UNION ALL `));
  for (const row of result.rows as { id: number; count: number; last_at: Date | string | null }[]) {
    counts.set(row.id, { count: row.count, lastAt: toDate(row.last_at) });
  }
  return counts;
}

/**
 * Exact distinct-value counts of top-level keys over every live record
 * (JSON equality: 1 and "1" differ; a missing key is not a value).
 */
export async function exactDistinctCounts(collectionId: number, keys: string[]): Promise<Record<string, number>> {
  if (keys.length === 0) return {};
  const cols = keys.map((k, i) => sql`count(DISTINCT t.data->${k}::text)::int AS ${sql.raw(`"d${i}"`)}`);
  const result = await db.execute(sql`SELECT ${sql.join(cols, sql`, `)} FROM ${table(collectionId)} t WHERE t.deleted_at IS NULL`);
  const row = result.rows[0] as Record<string, number>;
  return Object.fromEntries(keys.map((k, i) => [k, Number(row[`d${i}`])]));
}

/**
 * Postgres's estimate of distinct values for top-level keys that have a
 * ready projection, from pg_stats (n_distinct, a fraction of reltuples
 * when negative): the table's statistics for a legacy projection column,
 * the projection index's own statistics (its first column) for an
 * expression projection. Keys without a ready projection or without
 * statistics yet (ANALYZE has not run since the index was built) are left
 * out.
 */
export async function estimatedDistinctCounts(collectionId: number, storage: unknown, keys: string[]): Promise<Record<string, number>> {
  const registry = readQueryRegistry(storage);
  const name = collectionTableName(collectionId);
  // pg_stats relation name and column -> field.
  const sources = new Map<string, string>();
  for (const p of registry.projections) {
    if (p.path || !keys.includes(p.field)) continue;
    // An index's expression column is named by Postgres ("case" for ours): matched as attnum 1 below, "" here.
    sources.set(JSON.stringify(p.kind === "expression" ? [indexName(name, p.column), ""] : [name, p.column]), p.field);
  }
  if (sources.size === 0) return {};
  const pairs = [...sources.keys()].map((k) => JSON.parse(k) as [string, string]);
  const result = await db.execute(sql`
    SELECT w.rel AS tablename, w.col AS attname, s.n_distinct, c.reltuples
    FROM unnest(${toTextArrayLiteral(pairs.map((p) => p[0]))}::text[], ${toTextArrayLiteral(pairs.map((p) => p[1]))}::text[]) AS w(rel, col)
    JOIN pg_stats s ON s.schemaname = current_schema() AND s.tablename = w.rel
      AND s.attname = CASE WHEN w.col = '' THEN (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = to_regclass(w.rel) AND a.attnum = 1) ELSE w.col END
    JOIN pg_class c ON c.relname = ${name} AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = s.schemaname)`);
  const out: Record<string, number> = {};
  for (const row of result.rows as { tablename: string; attname: string; n_distinct: number; reltuples: number }[]) {
    const nd = Number(row.n_distinct);
    const estimate = nd >= 0 ? nd : Math.round(-nd * Number(row.reltuples));
    const field = sources.get(JSON.stringify([row.tablename, row.attname]));
    if (field !== undefined && Number.isFinite(estimate) && estimate > 0) out[field] = Math.round(estimate);
  }
  return out;
}
