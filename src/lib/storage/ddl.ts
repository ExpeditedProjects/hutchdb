import { sql, type SQL } from "drizzle-orm";
import {
  childTableName,
  collectionTableName,
  ident,
  identLiteral,
  indexName,
  pgType,
  triggerName,
  type Projection,
  type Unwind,
} from "./registry";

/** Anything that can run a drizzle SQL chunk — the db or a transaction. */
export type Executor = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * DDL for layout='table' collections. Every identifier here comes from the
 * registry (already sanitized) and is re-checked by ident(); every JSON key
 * is passed to a SQL helper (drizzle/0021) as a bound parameter and quoted
 * there with %L. No user string is ever concatenated into statement text.
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

export async function dropCollectionTable(ex: Executor, collectionId: number): Promise<void> {
  // DROP ... CASCADE only removes the child tables' FK constraints, so the
  // unwind tables (hc_<id>__*) are dropped by name first.
  const parent = collectionTableName(collectionId);
  const children = await ex.execute(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename LIKE ${`${parent}\_\_%`}`);
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
 * Add a stored generated projection column plus its btree index. Idempotent:
 * both statements are IF NOT EXISTS.
 */
export async function addProjection(ex: Executor, collectionId: number, projection: Projection): Promise<void> {
  const table = collectionTableName(collectionId);
  if (projection.path) {
    await ex.execute(sql`SELECT hc_add_path_projection(${table}, ${projection.column}, ${toTextArrayLiteral(projection.path)}::text[], ${projection.type})`);
  } else {
    await ex.execute(sql`SELECT hc_add_projection(${table}, ${projection.column}, ${projection.field}, ${projection.type})`);
  }
  await ex.execute(sql`
    CREATE INDEX IF NOT EXISTS ${ident(indexName(table, projection.column))}
    ON ${ident(table)} (${ident(projection.column)})`);
}

/**
 * Create the child table for an unwind, its indexes and the parent triggers
 * that keep it in sync, then backfill it from existing parent rows. The
 * registry entry must already be stored in collections.storage because the
 * trigger and backfill read the path and element columns from there.
 */
export async function addUnwind(ex: Executor, collectionId: number, unwind: Unwind): Promise<void> {
  const parent = collectionTableName(collectionId);
  const child = unwind.table;
  if (child !== childTableName(collectionId, unwind.path)) {
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
  // extra btree is only built on each projected element column.
  for (const f of unwind.fields) {
    await ex.execute(sql`
      CREATE INDEX IF NOT EXISTS ${ident(indexName(child, f.column))}
      ON ${ident(child)} (${ident(f.column)})`);
  }

  await ex.execute(sql`DROP TRIGGER IF EXISTS ${ident(triggerName(child, "ins"))} ON ${ident(parent)}`);
  await ex.execute(sql`
    CREATE TRIGGER ${ident(triggerName(child, "ins"))}
    AFTER INSERT ON ${ident(parent)}
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION hc_sync_unwind(${sql.raw(String(collectionId))}, ${identLiteral(child)})`);
  await ex.execute(sql`DROP TRIGGER IF EXISTS ${ident(triggerName(child, "upd"))} ON ${ident(parent)}`);
  await ex.execute(sql`
    CREATE TRIGGER ${ident(triggerName(child, "upd"))}
    AFTER UPDATE ON ${ident(parent)}
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION hc_sync_unwind(${sql.raw(String(collectionId))}, ${identLiteral(child)})`);

  await ex.execute(sql`SELECT hc_unwind_backfill(${collectionId}, ${parent}, ${child})`);
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
