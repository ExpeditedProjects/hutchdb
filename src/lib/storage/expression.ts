import { sql, type SQL } from "drizzle-orm";
import { toTextArrayLiteral } from "./ddl";
import { ident, MAX_INDEXED_TEXT_BYTES, type Projection } from "./registry";

/**
 * The value a projection holds for one row, as SQL over the document
 * column of `alias` (or the bare `data` column when alias is omitted).
 *
 * A legacy projection is its stored generated column. An "expression"
 * projection is the guarded cast itself, written to be the same expression
 * Postgres builds for its index: the index is created from
 * hc_cast_expr / hc_cast_path_expr (migration 0021) with the key or path
 * as a %L literal, and here the key or path is a bound parameter with the
 * same type, which Postgres folds into the same constant when it plans the
 * statement. The planner only matches an expression index against an
 * identical expression, so any change here must be made in those SQL
 * helpers too (builder.integration.test.ts checks every type with EXPLAIN).
 */
export function projectionValue(p: Projection, alias?: "t"): SQL {
  if (p.kind !== "expression") return alias ? sql`${sql.raw(alias)}.${ident(p.column)}` : ident(p.column);
  const data = alias ? sql`${sql.raw(alias)}.data` : sql`data`;
  const json = p.path ? sql`${data} #> ${toTextArrayLiteral(p.path)}::text[]` : sql`${data} -> ${p.field}::text`;
  const text = p.path ? sql`${data} #>> ${toTextArrayLiteral(p.path)}::text[]` : sql`${data} ->> ${p.field}::text`;
  switch (p.type) {
    case "number":
      return sql`(CASE WHEN jsonb_typeof(${json}) = 'number' THEN hc_safe_float8(${json}) END)`;
    case "boolean":
      return sql`(CASE WHEN jsonb_typeof(${json}) = 'boolean' THEN (${json})::boolean END)`;
    case "date":
      return sql`(CASE WHEN jsonb_typeof(${json}) = 'string' AND (${text}) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN hc_safe_date(${text}) END)`;
    default:
      return sql`(CASE WHEN jsonb_typeof(${json}) = 'string' AND octet_length(${text}) <= ${sql.raw(String(MAX_INDEXED_TEXT_BYTES))} THEN ${text} END)`;
  }
}
