import { sql, type SQL } from "drizzle-orm";
import {
  collectionTableName,
  ident,
  identLiteral,
  indexName,
  isChildTableNameFor,
  pgType,
  searchIndexName,
  triggerName,
  type Projection,
  type Unwind,
} from "./registry";

/** Anything that can run a drizzle SQL chunk — the db or a transaction. */
export type Executor = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * DDL for collection tables. Every identifier here comes from the
 * registry (already sanitized) and is re-checked by ident(); every JSON key
 * is passed to a SQL helper (drizzle/0021) as a bound parameter and quoted
 * there with %L. No user string is ever concatenated into statement text
 * by the app.
 */

export async function createCollectionTable(ex: Executor, collectionId: number): Promise<void> {
  const table = ident(collectionTableName(collectionId));
  await ex.execute(sql`
    CREATE TABLE IF NOT EXISTS ${table} (
      id serial PRIMARY KEY,
      data jsonb NOT NULL,
      source text,
      status text DEFAULT 'active',
      deleted_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`);
  await ex.execute(sql`
    CREATE INDEX IF NOT EXISTS ${ident(indexName(collectionTableName(collectionId), "data_gin"))}
    ON ${table} USING gin (data jsonb_path_ops)`);
  await ex.execute(sql`
    CREATE INDEX IF NOT EXISTS ${ident(indexName(collectionTableName(collectionId), "created_at"))}
    ON ${table} (created_at)`);
}

/**
 * lock_timeout for DDL a request runs on a collection table (DROP TABLE on
 * delete, the unique-key change). A background build holds a lock on the
 * table for as long as it runs; without this the request would wait the
 * whole statement timeout, and every read and write of the table would
 * queue behind it.
 */
export const REQUEST_DDL_LOCK_TIMEOUT_MS = 2000;

/** What a request is told when its DDL could not get the table lock in time (see REQUEST_DDL_LOCK_TIMEOUT_MS). */
export const INDEX_BUILD_BUSY_MESSAGE = "an index on this collection is being built in the background; try again in a minute";

/** SET LOCAL lock_timeout = REQUEST_DDL_LOCK_TIMEOUT_MS, inside the caller's transaction. */
export async function setRequestDdlLockTimeout(ex: Executor): Promise<void> {
  await ex.execute(sql`SELECT set_config('lock_timeout', ${String(REQUEST_DDL_LOCK_TIMEOUT_MS)}, true)`);
}

export async function dropCollectionTable(ex: Executor, collectionId: number): Promise<void> {
  // DROP ... CASCADE only removes the child tables' FK constraints, so the
  // unwind tables (hc_<id>__*) are dropped by name first. starts_with, not
  // LIKE: "_" is a LIKE wildcard, so hc_1__% would also match hc_100.
  const parent = collectionTableName(collectionId);
  const children = await ex.execute(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND starts_with(tablename, ${`${parent}__`})`);
  for (const row of children.rows as { tablename: string }[]) {
    await ex.execute(sql`DROP TABLE IF EXISTS ${ident(row.tablename)} CASCADE`);
  }
  await ex.execute(sql`DROP TABLE IF EXISTS ${ident(parent)} CASCADE`);
}

export async function collectionTableExists(ex: Executor, collectionId: number): Promise<boolean> {
  const result = await ex.execute(sql`SELECT to_regclass(${collectionTableName(collectionId)}) IS NOT NULL AS present`);
  return result.rows[0]?.present === true;
}

/**
 * The CREATE INDEX CONCURRENTLY statement for an expression projection:
 * a btree over the guarded cast of the document value (the same
 * expression projectionValue() emits for queries), then the default record
 * order (created_at DESC, id DESC), so a filter on it with the default
 * order and a limit reads matching rows already in order from this one
 * index. Postgres writes the statement: format() quotes the identifiers
 * with %I, and hc_cast_expr / hc_cast_path_expr quote the JSON key or path
 * (user data, a bound parameter here) with %L. CREATE INDEX CONCURRENTLY
 * can't run inside a function or transaction, so the builder executes the
 * returned text itself.
 */
export async function projectionIndexDdl(ex: Executor, collectionId: number, projection: Projection): Promise<string> {
  const table = collectionTableName(collectionId);
  const index = indexName(table, projection.column);
  ident(index);
  const expr = projection.path
    ? sql`hc_cast_path_expr('data', ${toTextArrayLiteral(projection.path)}::text[], ${projection.type})`
    : sql`hc_cast_expr('data', ${projection.field}::text, ${projection.type})`;
  const result = await ex.execute(sql`
    SELECT format('CREATE INDEX CONCURRENTLY IF NOT EXISTS %I ON %I ((%s), created_at DESC, id DESC)', ${index}::text, ${table}::text, ${expr}) AS ddl`);
  return result.rows[0].ddl as string;
}

/**
 * The full-text search GIN: the exact expression `search` filters with
 * (compiler.ts, rows.ts searchRecords), so the planner can serve it.
 */
export function searchIndexDdl(collectionId: number): SQL {
  const table = collectionTableName(collectionId);
  return sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(searchIndexName(table))} ON ${ident(table)} USING gin (to_tsvector('english', data::text))`;
}

/**
 * Create the child table for an unwind, its indexes and the parent triggers
 * that keep it in sync, without backfilling it (backfillUnwindRows does
 * that, in batches). Idempotent. The registry entry must already be stored
 * in collections.storage because the trigger reads the path and element
 * columns from there. Run in one transaction: CREATE TRIGGER waits for
 * in-flight writes to the parent, so every write after it commits fires
 * the trigger and every row from before is visible to the backfill.
 */
export async function createUnwindTable(ex: Executor, collectionId: number, unwind: Unwind): Promise<void> {
  const parent = collectionTableName(collectionId);
  const child = unwind.table;
  if (!isChildTableNameFor(collectionId, unwind.path, child)) {
    throw new Error(`Unwind table '${child}' does not match path '${unwind.path}'`);
  }

  const columnDefs = unwind.fields.map((f) => sql`, ${ident(f.column)} ${sql.raw(pgType(f.type))}`);
  await ex.execute(sql`
    CREATE TABLE IF NOT EXISTS ${ident(child)} (
      parent_id int NOT NULL REFERENCES ${ident(parent)}(id) ON DELETE CASCADE,
      idx int NOT NULL,
      PRIMARY KEY (parent_id, idx)
      ${sql.join(columnDefs, sql``)}
    )`);
  // The primary key (parent_id, idx) already serves parent_id lookups; the
  // extra btree is only built on each projected element column. The table
  // is new and empty here (or being rebuilt after a failed attempt), so a
  // plain CREATE INDEX is cheap.
  for (const f of unwind.fields) {
    await ex.execute(sql`
      CREATE INDEX IF NOT EXISTS ${ident(indexName(child, f.column))}
      ON ${ident(child)} (${ident(f.column)})`);
  }

  // CREATE OR REPLACE: one statement per trigger, so the SHARE ROW
  // EXCLUSIVE lock writes queue behind is requested once each, not twice.
  await ex.execute(sql`
    CREATE OR REPLACE TRIGGER ${ident(triggerName(child, "ins"))}
    AFTER INSERT ON ${ident(parent)}
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION hc_sync_unwind(${sql.raw(String(collectionId))}, ${identLiteral(child)})`);
  await ex.execute(sql`
    CREATE OR REPLACE TRIGGER ${ident(triggerName(child, "upd"))}
    AFTER UPDATE ON ${ident(parent)}
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION hc_sync_unwind(${sql.raw(String(collectionId))}, ${identLiteral(child)})`);
}

/**
 * Backfill the child rows of the parent rows with lo < id <= hi (only
 * `only`, when given). Returns the ids it could not lock because a writer
 * holds them (see hc_unwind_backfill_rows, migration 0022).
 */
export async function backfillUnwindRows(ex: Executor, collectionId: number, unwind: Unwind, lo: number, hi: number, only: number[] | null): Promise<number[]> {
  const parent = collectionTableName(collectionId);
  ident(unwind.table);
  const onlyArg = only ? sql`${`{${only.map((n) => Math.trunc(n)).join(",")}}`}::int[]` : sql`NULL::int[]`;
  const result = await ex.execute(sql`
    SELECT hc_unwind_backfill_rows(${collectionId}::int, ${parent}::text, ${unwind.table}::text, ${lo}::int, ${hi}::int, ${onlyArg}) AS skipped`);
  return parsePgIntArray(result.rows[0].skipped);
}

function parsePgIntArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") return value.replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
  return [];
}

/**
 * Point the table's unique key at `keys` (uk_* generated columns + partial
 * unique index). Empty keys removes it. Throws when existing rows violate
 * the new key.
 */
export async function setUniqueKey(ex: Executor, collectionId: number, keys: string[]): Promise<void> {
  await ex.execute(sql`SELECT hc_set_unique_key(${collectionTableName(collectionId)}, ${toTextArrayLiteral(keys)}::text[])`);
}

/** Serialize a string array as a Postgres array literal for a bound param. */
export function toTextArrayLiteral(values: string[]): string {
  const quoted = values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${quoted.join(",")}}`;
}
