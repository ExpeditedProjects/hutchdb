import { db } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  AGGREGATION_OPS,
  buildFilterConditions,
  buildOperatorCondition,
  escapeBucket,
  isOperatorSpec,
  MAX_GROUP_BY_KEYS,
  normalizeGroupBy,
  projectData,
  type QueryParams,
} from "@/lib/db/queries";
import { isPlainObject } from "@/lib/validation";
import {
  collectionTableName,
  findPathProjection,
  findProjection,
  findUnwind,
  ident,
  indexName,
  readRegistry,
  type Projection,
  type ProjectionType,
  type StorageRegistry,
  type Unwind,
  valueFitsType,
} from "./registry";
import { fetchEmbeddedRecords, RECORD_COLUMNS, toRecord, type TableRecord } from "./rows";

/**
 * Query compiler for layout='table' collections. Same QueryParams and result
 * shapes as queryRecords over the shared table, plus `indexed`/`plan`.
 *
 * Field paths:
 * - `field`            a top-level key (projected column when available)
 * - `a.b.c`            a path through nested objects: its projected column
 *                      when inference made one, else data #> '{a,b,c}'
 *                      (the same expressions as the shared layout, without
 *                      its literal "a.b.c" top-level key fallback)
 * - `arr.key[.deeper]` a path into an array of objects; `arr` is an unwound
 *                      array (child table) or one detected in the documents.
 *                      `arr.key` uses the child column when there is one;
 *                      anything deeper falls back to jsonpath (filters) or
 *                      jsonb_array_elements (aggregates) over the document.
 *
 * `indexed` is true only when EXPLAIN shows an index that serves a clause
 * the caller wrote (filter field or path, search, sort); the unique-key
 * index and the created_at index count only when the caller filtered on a
 * unique key field or filtered/sorted on created_at. `id` in a filter or
 * sort is the document field, as in the shared layout, so the primary key
 * never counts.
 *
 * A projection never changes a result, only the plan. Filters route to a
 * column only where the column comparison is provably the same as the
 * document comparison; sums and averages over a float8 column go through
 * its shortest text form to numeric, so they add exactly the numbers the
 * documents hold; and a sort (or a date range) uses the column only while
 * the registry says no live document holds a value of another type at
 * that path (Projection.mixed), because the column would order those
 * values differently from jsonb.
 */

/** Page ceiling, as in the shared layout: 1,000 rows unless the caller (export) raises limitCap. */
export const DEFAULT_LIMIT_CAP = 1000;
/** Hard ceiling for limitCap. */
export const TABLE_LIMIT_CAP = 10_000;
export { MAX_GROUP_BY_KEYS };
const DEFAULT_LIMIT = 50;
const EXPLAIN_TTL_MS = 60_000;
const IN_LIST_LIMIT = 1000;
const PATH_RE = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

export const SORT_HELP =
  "sort accepts a top-level field, a dotted path into nested objects (a.b.c), created_at or updated_at — " +
  "and with group_by/aggregate, an aggregate alias or a group_by key — optionally prefixed with - for descending";

type Collection = { id: number; storage: unknown };

export type IndexReport = { indexed: boolean; plan: string; reason?: string };

export type TableRecordsResult = {
  records: TableRecord[];
  total: number;
  count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
} & IndexReport;

export type TableAggregateResult = {
  results: Record<string, unknown>[];
  total: number;
  count: number;
  limit: number;
} & IndexReport;

/**
 * A clause the caller wrote and the indexes that could serve it. `note`
 * explains a clause no index can serve (an unprojected nested path), and is
 * added to the response's reason when the query is not indexed.
 */
export type Clause = { label: string; indexes: string[]; note?: string };

export type CompiledQuery =
  | { kind: "records"; query: SQL; countQuery: SQL; limit: number; offset: number; fields?: string[]; clauses: Clause[] }
  | {
      kind: "aggregate";
      query: SQL;
      limit: number;
      nested: { path: string; route: "child" | "lateral" } | null;
      stripPaths: string[];
      clauses: Clause[];
    };

export type CompileOptions = {
  /** First segments of dotted fields that hold arrays of objects but are not unwound. */
  arrayPaths?: Iterable<string>;
};

// ── Paths ────────────────────────────────────────────────────────────────────

type ParsedPath =
  | { kind: "parent"; field: string }
  | { kind: "object"; segments: string[] }
  | { kind: "nested"; path: string; rest: string[]; unwind?: Unwind };

function parsePath(registry: StorageRegistry, arrayPaths: Set<string>, field: string): ParsedPath {
  // Like the shared layout, a key that is not a valid dotted path (empty or
  // non-identifier segments) is a literal top-level key.
  const segments = field.split(".");
  if (segments.length === 1 || !PATH_RE.test(field)) return { kind: "parent", field };
  const unwind = findUnwind(registry, segments[0]);
  if (unwind || arrayPaths.has(segments[0])) {
    return { kind: "nested", path: segments[0], rest: segments.slice(1), unwind };
  }
  return { kind: "object", segments };
}

/** `{a,b,c}` for a `#>` path, as a bound text[] parameter. */
function pathArray(segments: string[]): SQL {
  const literal = `{${segments.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}

function assertPathName(field: string): void {
  if (!PATH_RE.test(field)) {
    throw new Error(`Invalid field name '${field}' — only letters, numbers, underscores, and dots between path segments are allowed`);
  }
}

// ── Literal / column helpers ─────────────────────────────────────────────────

/** A literal the column can compare: the same test as a document value landing in the column. */
function literalMatches(type: ProjectionType, value: unknown): boolean {
  return valueFitsType(type, value);
}

function typedLiteral(type: ProjectionType, value: unknown): SQL {
  switch (type) {
    case "number": return sql`${value}::float8`;
    case "boolean": return sql`${value}::boolean`;
    case "date": return sql`${value}::date`;
    default: return sql`${value}::text`;
  }
}

const COMPARISONS: Record<string, string> = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" };

/**
 * Compile one operator (or plain equality, op === null) against a typed
 * column. Returns null when the operator or literal can't use the column,
 * in which case the caller falls back to the jsonb path.
 */
function columnCondition(column: SQL, type: ProjectionType, op: string | null, operand: unknown, mixed = false): SQL | null {
  if (op === null) {
    return literalMatches(type, operand) ? sql`${column} = ${typedLiteral(type, operand)}` : null;
  }
  if (Object.hasOwn(COMPARISONS, op)) {
    // The document route rejects a boolean operand, and compares dates as
    // text: a non-date string ("2026-01-01T10:00") still compares there, so
    // a date column only stands in for it while no such value exists.
    if (type === "boolean" || (type === "date" && mixed)) return null;
    return literalMatches(type, operand) ? sql`${column} ${sql.raw(COMPARISONS[op])} ${typedLiteral(type, operand)}` : null;
  }
  if (op === "$ne") {
    return literalMatches(type, operand) ? sql`${column} IS DISTINCT FROM ${typedLiteral(type, operand)}` : null;
  }
  if (op === "$in" || op === "$nin") {
    if (!Array.isArray(operand) || operand.length > IN_LIST_LIMIT || !operand.every((v) => literalMatches(type, v))) return null;
    if (operand.length === 0) return op === "$in" ? sql`false` : sql`true`;
    const list = sql.join(operand.map((v) => typedLiteral(type, v)), sql`, `);
    return op === "$in" ? sql`${column} IN (${list})` : sql`(${column} IS NULL OR ${column} NOT IN (${list}))`;
  }
  return null;
}

// ── jsonpath fallback for dotted keys ────────────────────────────────────────

function jsonpathKey(key: string): string {
  return `.${JSON.stringify(key)}`;
}

function jsonpathLiteral(value: unknown): string | null {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return null;
}

type NestedCondition = { op: string | null; operand: unknown };
type PathCondition = NestedCondition & { segments: string[] };

/**
 * Conditions on `<path>.<key...>` compiled as jsonpath predicates over the
 * document. The jsonpath text is itself a bound parameter; literals inside
 * it are JSON-encoded, so nothing from the filter reaches SQL text. Lax
 * mode makes `[*]` accept both an array of objects and a single object.
 * Positive conditions on one path merge into a single predicate so they
 * must hold for the same element, exactly like the child-table EXISTS.
 */
function jsonpathConditions(data: SQL, path: string, conds: PathCondition[]): SQL[] {
  const base = `$${jsonpathKey(path)}[*]`;
  const same: string[] = [];
  const out: SQL[] = [];
  const exists = (predicate: string) => sql`${data} @? ${`${base} ? (${predicate})`}::jsonpath`;

  for (const { op, operand, segments } of conds) {
    const accessor = segments.map(jsonpathKey).join("");
    if (op === null || op === "$ne") {
      const lit = jsonpathLiteral(operand);
      if (lit === null) {
        // Object/array operand: containment of a one-element array under
        // the path has the same "some element matches" meaning.
        const nested = segments.reduceRight<unknown>((acc, seg) => ({ [seg]: acc }), operand);
        const doc = JSON.stringify({ [path]: [nested] });
        out.push(op === null ? sql`${data} @> ${doc}::jsonb` : sql`NOT (${data} @> ${doc}::jsonb)`);
      } else if (op === null) {
        same.push(`@${accessor} == ${lit}`);
      } else {
        out.push(sql`NOT (${exists(`@${accessor} == ${lit}`)})`);
      }
    } else if (Object.hasOwn(COMPARISONS, op)) {
      const lit = jsonpathLiteral(operand);
      if (typeof operand !== "number" && typeof operand !== "string") throw new Error(`${op} requires a number or string operand`);
      same.push(`@${accessor} ${COMPARISONS[op]} ${lit}`);
    } else if (op === "$in" || op === "$nin") {
      if (!Array.isArray(operand)) throw new Error(`${op} requires an array operand`);
      if (operand.length > IN_LIST_LIMIT) throw new Error(`$in/$nin arrays are limited to ${IN_LIST_LIMIT} elements`);
      const lits = operand.map(jsonpathLiteral);
      if (lits.some((l) => l === null)) throw new Error(`${op} on a nested path requires scalar values`);
      const predicate = lits.length === 0 ? "false" : lits.map((l) => `@${accessor} == ${l}`).join(" || ");
      if (op === "$in") same.push(`(${predicate})`);
      else out.push(sql`NOT (${exists(predicate)})`);
    } else if (op === "$exists") {
      if (typeof operand !== "boolean") throw new Error("$exists requires a boolean operand");
      if (operand) same.push(`exists(@${accessor})`);
      else out.push(sql`NOT (${exists(`exists(@${accessor})`)})`);
    } else if (op === "$contains") {
      if (typeof operand !== "string") throw new Error("$contains requires a string operand");
      const pattern = JSON.stringify(operand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      same.push(`@${accessor} like_regex ${pattern} flag "i"`);
    } else {
      throw new Error(`Unsupported filter operator '${op}'. Supported: $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $contains`);
    }
  }
  if (same.length > 0) out.unshift(exists(same.join(" && ")));
  return out;
}

/** The GIN index can serve a jsonpath predicate only when every condition is an equality. */
function jsonpathIndexable(conds: PathCondition[]): boolean {
  return conds.every((c) => c.op === null || c.op === "$in");
}

// ── Filter compilation ───────────────────────────────────────────────────────

type ChildGroup = {
  unwind: Unwind;
  conditions: SQL[];
  /** The same conditions as a plain filter over one element (for the lateral route). */
  raw: Record<string, unknown>;
};

type ParsedFilter = {
  /** Conditions on the parent table alias `t`. */
  parent: SQL[];
  /** Per unwound path: child-column conditions (for EXISTS / child aggregates). */
  child: Map<string, ChildGroup>;
  clauses: Clause[];
};

function entries(value: unknown): NestedCondition[] {
  return isOperatorSpec(value)
    ? Object.entries(value).map(([op, operand]) => ({ op, operand }))
    : [{ op: null, operand: value }];
}

type Ctx = {
  registry: StorageRegistry;
  arrayPaths: Set<string>;
  parent: string;
  gin: string;
};

function compileFilter(ctx: Ctx, filter: Record<string, unknown>): ParsedFilter {
  const { registry, parent: parentTable, gin } = ctx;
  const parent: SQL[] = [];
  const child = new Map<string, ChildGroup>();
  const clauses: Clause[] = [];
  const plainFallback: Record<string, unknown> = {};
  const data = sql`t.data`;
  // Dotted conditions that could not use a child column, grouped by their
  // first segment so they compile to one jsonpath predicate per path.
  const leftovers = new Map<string, PathCondition[]>();
  const uniqueKey = registry.unique_key ?? [];

  for (const [key, value] of Object.entries(filter)) {
    const parsed = parsePath(registry, ctx.arrayPaths, key);

    if (parsed.kind === "object") {
      parent.push(...objectPathConditions(ctx, key, parsed.segments, value, clauses));
      continue;
    }

    if (parsed.kind === "nested") {
      const { path, rest, unwind } = parsed;
      const column = rest.length === 1 ? unwind?.fields.find((f) => f.field === rest[0]) : undefined;
      for (const cond of entries(value)) {
        const routed = unwind && column ? columnCondition(sql`c.${ident(column.column)}`, column.type, cond.op, cond.operand) : null;
        if (routed && unwind && column) {
          const group = child.get(path) ?? { unwind, conditions: [], raw: {} };
          group.conditions.push(routed);
          if (cond.op === null) group.raw[rest[0]] = cond.operand;
          else {
            const prev = group.raw[rest[0]];
            group.raw[rest[0]] = { ...(isOperatorSpec(prev) ? prev : {}), [cond.op]: cond.operand };
          }
          child.set(path, group);
          clauses.push({ label: `filter on ${key}`, indexes: [indexName(unwind.table, column.column)] });
        } else {
          const list = leftovers.get(path) ?? [];
          list.push({ ...cond, segments: rest });
          leftovers.set(path, list);
        }
      }
      continue;
    }

    const projection = findProjection(registry, key);
    if (!isOperatorSpec(value)) {
      const routed = projection ? columnCondition(sql`t.${ident(projection.column)}`, projection.type, null, value) : null;
      if (routed && projection) {
        parent.push(routed);
        clauses.push({ label: `filter on ${key}`, indexes: [indexName(parentTable, projection.column)] });
      } else if (uniqueKey.includes(key) && value !== undefined) {
        // Equality on a unique-key field compares the uk_<n> generated
        // column, which the partial unique index serves.
        parent.push(sql`t.${ident(`uk_${uniqueKey.indexOf(key)}`)} = ${JSON.stringify(value)}::jsonb`);
        clauses.push({ label: `filter on ${key}`, indexes: [`${parentTable}_uk`] });
      } else {
        plainFallback[key] = value;
        clauses.push({ label: `filter on ${key}`, indexes: [gin] });
      }
      continue;
    }
    for (const [op, operand] of Object.entries(value)) {
      const routed = projection ? columnCondition(sql`t.${ident(projection.column)}`, projection.type, op, operand, projection.mixed) : null;
      parent.push(routed ?? buildOperatorCondition(key, op, operand, null, data));
      clauses.push({ label: `filter on ${key} (${op})`, indexes: routed && projection ? [indexName(parentTable, projection.column)] : [] });
    }
  }

  for (const [path, conds] of leftovers) {
    parent.push(...jsonpathConditions(data, path, conds));
    for (const c of conds) {
      clauses.push({
        label: `filter on ${[path, ...c.segments].join(".")}${c.op ? ` (${c.op})` : ""}`,
        indexes: jsonpathIndexable([c]) ? [gin] : [],
      });
    }
  }
  if (Object.keys(plainFallback).length > 0) parent.unshift(...buildFilterConditions(plainFallback, data));
  return { parent, child, clauses };
}

/** {a: {b: {c: value}}} for path [a, b, c]: the containment shape of a nested equality. */
function nestValue(segments: string[], value: unknown): Record<string, unknown> {
  return segments.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>;
}

function unprojectedNote(field: string): string {
  return `'${field}' is a nested object path with no projection, so it is evaluated over the stored documents`;
}

function mixedNote(field: string): string {
  return `'${field}' holds values of more than one type, so its projection cannot order or range-compare them like the documents do`;
}

/**
 * Conditions on a dotted path into nested objects. Each condition uses the
 * path's projection column when one exists and the column comparison means
 * the same as the document's; otherwise the document expression, which is
 * the shared layout's (containment for equality, `#>` / `#>>` for
 * operators) minus its literal top-level key fallback.
 */
function objectPathConditions(ctx: Ctx, key: string, segments: string[], value: unknown, clauses: Clause[]): SQL[] {
  const projection = findPathProjection(ctx.registry, segments);
  const out: SQL[] = [];
  for (const cond of entries(value)) {
    const label = `filter on ${key}${cond.op ? ` (${cond.op})` : ""}`;
    const routed = projection ? columnCondition(sql`t.${ident(projection.column)}`, projection.type, cond.op, cond.operand, projection.mixed) : null;
    if (routed && projection) {
      out.push(routed);
      clauses.push({ label, indexes: [indexName(ctx.parent, projection.column)] });
      continue;
    }
    const note = projection ? undefined : unprojectedNote(key);
    if (cond.op === null) {
      out.push(sql`t.data @> ${JSON.stringify(nestValue(segments, cond.operand))}::jsonb`);
      clauses.push({ label, indexes: [ctx.gin], ...(note ? { note } : {}) });
    } else {
      out.push(buildOperatorCondition(key, cond.op, cond.operand, segments, sql`t.data`, false));
      clauses.push({ label, indexes: [], ...(note ? { note } : {}) });
    }
  }
  return out;
}

function existsConditions(parsed: ParsedFilter, except?: string): SQL[] {
  const out: SQL[] = [];
  for (const [path, { unwind, conditions }] of parsed.child) {
    if (path === except) continue;
    out.push(sql`EXISTS (SELECT 1 FROM ${ident(unwind.table)} c WHERE c.parent_id = t.id AND ${sql.join(conditions, sql` AND `)})`);
  }
  return out;
}

// ── Sort ─────────────────────────────────────────────────────────────────────

function parseSort(sort: string): { field: string; dir: SQL; descending: boolean } {
  const descending = sort.startsWith("-");
  const field = descending ? sort.slice(1) : sort;
  if (!field) throw new Error(`Invalid sort field '${sort}' — ${SORT_HELP}`);
  return { field, dir: descending ? sql`DESC` : sql`ASC`, descending };
}

type SortKey = { orderBy: SQL; clause?: Clause; tiebreak?: SQL };

function compileRecordSort(ctx: Ctx, sort: string | undefined): { orderBy: SQL; clause?: Clause } {
  const { tiebreak, ...sorted } = compileRecordSortKey(ctx, sort);
  // Ties (equal values, same-batch created_at) break on the row id so a
  // page of top-N results is the same every time; as in the shared layout,
  // in the sort's direction for created_at, updated_at and id, else ascending.
  return { ...sorted, orderBy: sql`${sorted.orderBy}, ${tiebreak ?? (sort ? sql`t.id ASC` : sql`t.id DESC`)}` };
}

function compileRecordSortKey(ctx: Ctx, sort: string | undefined): SortKey {
  if (!sort) return { orderBy: sql`t.created_at DESC` };
  const { field, dir } = parseSort(sort);
  const sameDir = sql`t.id ${dir}`;
  const { registry, parent } = ctx;
  // `id` is a document field here, as in the shared layout (the row id is
  // not addressable by filter or sort), so the primary key never serves a
  // caller's clause.
  if (field === "created_at") {
    return { orderBy: sql`t.created_at ${dir}`, clause: { label: "sort on created_at", indexes: [indexName(parent, "created_at")] }, tiebreak: sameDir };
  }
  if (field === "updated_at") return { orderBy: sql`t.updated_at ${dir}`, clause: { label: "sort on updated_at", indexes: [] }, tiebreak: sameDir };
  if (field === "id" && !findProjection(registry, "id")) {
    // A data field named `id` sorts as it always has; records without one
    // fall through to the row id, so `id` is always a valid sort.
    return { orderBy: sql`t.data->${field}::text ${dir} NULLS LAST`, clause: { label: "sort on id", indexes: [] }, tiebreak: sameDir };
  }
  if (!PATH_RE.test(field)) throw new Error(`Invalid sort field '${field}' — ${SORT_HELP}`);

  const parsed = parsePath(registry, ctx.arrayPaths, field);
  if (parsed.kind === "nested") {
    throw new Error(`Cannot sort records on '${field}': '${parsed.path}' is an array of objects. Sort on a nested array is available in aggregate queries (group_by/aggregate) by aggregate alias or group_by key.`);
  }
  const label = `sort on ${field}`;
  // The column orders exactly like the jsonb value only while every live
  // value at the path has the column's type (see Projection.mixed).
  if (parsed.kind === "object") {
    const projection = findPathProjection(registry, parsed.segments);
    if (projection && !projection.mixed) {
      return { orderBy: sql`t.${ident(projection.column)} ${dir} NULLS LAST`, clause: { label, indexes: [indexName(parent, projection.column)] } };
    }
    // `#>` keeps jsonb typing so numbers order numerically.
    return {
      orderBy: sql`t.data #> ${pathArray(parsed.segments)} ${dir} NULLS LAST`,
      clause: { label, indexes: [], note: projection ? mixedNote(field) : unprojectedNote(field) },
    };
  }
  const projection = findProjection(registry, field);
  if (projection && !projection.mixed) {
    return {
      orderBy: sql`t.${ident(projection.column)} ${dir} NULLS LAST`,
      clause: { label, indexes: [indexName(parent, projection.column)] },
    };
  }
  return { orderBy: sql`t.data->${field}::text ${dir} NULLS LAST`, clause: { label, indexes: [], ...(projection ? { note: mixedNote(field) } : {}) } };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

type AggregateSpec = Record<string, string | Record<string, string>>;

function aliasIdent(alias: string): SQL {
  assertPathName(alias);
  return sql.raw(`"${alias}"`);
}

/** Expressions for one field in a given source (parent columns, child columns or a lateral element). */
type FieldExprs = { numeric: SQL; text: SQL; jsonb: SQL };

/**
 * A float8 projection column as numeric for sum/avg/min/max. Through text,
 * not ::numeric: float8 -> numeric keeps 15 digits, while the shortest text
 * form (extra_float_digits >= 1, the default) is the decimal the document
 * holds, so a sum over the column equals the sum over the documents.
 */
function exactNumeric(column: SQL): SQL {
  return sql`${column}::text::numeric`;
}

function parentExprs(registry: StorageRegistry, field: string): FieldExprs {
  const projection = findProjection(registry, field);
  const numeric = projection?.type === "number"
    ? exactNumeric(sql`t.${ident(projection.column)}`)
    : sql`CASE WHEN jsonb_typeof(t.data->${field}::text) = 'number' THEN (t.data->>${field}::text)::numeric END`;
  return { numeric, text: sql`t.data->>${field}::text`, jsonb: sql`t.data->${field}::text` };
}

/** A nested object path: numbers from its projection when it has one, everything else from the document. */
function objectExprs(registry: StorageRegistry, segments: string[]): FieldExprs {
  const exprs = pathExprs(sql`t.data`, segments);
  const projection: Projection | undefined = findPathProjection(registry, segments);
  return projection?.type === "number" ? { ...exprs, numeric: exactNumeric(sql`t.${ident(projection.column)}`) } : exprs;
}

/** `src #> '{...}'` expressions for a path below a document or an element. */
function pathExprs(src: SQL, segments: string[]): FieldExprs {
  const arr = pathArray(segments);
  return {
    numeric: sql`CASE WHEN jsonb_typeof(${src} #> ${arr}) = 'number' THEN (${src} #>> ${arr})::numeric END`,
    text: sql`${src} #>> ${arr}`,
    jsonb: sql`${src} #> ${arr}`,
  };
}

function childExprs(unwind: Unwind, key: string): FieldExprs | null {
  const f = unwind.fields.find((x) => x.field === key);
  if (!f) return null;
  const col = sql`c.${ident(f.column)}`;
  return {
    numeric: f.type === "number" ? exactNumeric(col) : sql`NULL::numeric`,
    text: f.type === "text" ? col : sql`${col}::text`,
    jsonb: sql`to_jsonb(${col})`,
  };
}

function aggregateExpr(op: string, f: FieldExprs): SQL {
  switch (op) {
    case "min":
    case "max":
      return sql`coalesce(to_jsonb(${sql.raw(op)}(${f.numeric})), to_jsonb(${sql.raw(op)}(${f.text})))`;
    case "distinct":
      return sql`array_agg(distinct ${f.text})`;
    case "sum":
    case "avg":
      return sql`to_jsonb(${sql.raw(op)}(${f.numeric}))`;
    default:
      throw new Error(`Unsupported aggregation '${op}'. Supported: ${AGGREGATION_OPS}`);
  }
}

function parseAggregate(aggregate: AggregateSpec | undefined): { alias: string; op: string; field: string | null }[] {
  if (!aggregate) return [];
  return Object.entries(aggregate).map(([alias, spec]) => {
    if (spec === "count" || (isPlainObject(spec) && "count" in spec)) return { alias, op: "count", field: null };
    const entry = isPlainObject(spec) ? Object.entries(spec)[0] : undefined;
    if (!entry) {
      const label = typeof spec === "string" ? spec : JSON.stringify(spec);
      throw new Error(`Unsupported aggregation '${label}'. Supported: ${AGGREGATION_OPS}`);
    }
    const [op, field] = entry;
    assertPathName(field);
    return { alias, op, field };
  });
}

// ── compile ──────────────────────────────────────────────────────────────────

export function compileQuery(collection: Collection, params: Omit<QueryParams, "collectionId">, options: CompileOptions = {}): CompiledQuery {
  const registry = readRegistry(collection.storage);
  const parentTable = collectionTableName(collection.id);
  const ctx: Ctx = {
    registry,
    arrayPaths: new Set(options.arrayPaths ?? []),
    parent: parentTable,
    gin: indexName(parentTable, "data_gin"),
  };
  const table = ident(parentTable);
  const { filter, search, sort, fields, createdAfter, createdBefore, limit = DEFAULT_LIMIT, offset = 0, groupBy, aggregate, timeBucket, limitCap = DEFAULT_LIMIT_CAP } = params;

  const parsed = compileFilter(ctx, filter && Object.keys(filter).length > 0 ? filter : {});
  const clauses = [...parsed.clauses];
  const parent: SQL[] = [sql`t.deleted_at IS NULL`, ...parsed.parent];
  if (search) {
    parent.push(sql`to_tsvector('english', t.data::text) @@ plainto_tsquery('english', ${search})`);
    clauses.push({ label: "search", indexes: [] });
  }
  if (createdAfter) {
    parent.push(sql`t.created_at >= ${createdAfter}::timestamptz`);
    clauses.push({ label: "created_after", indexes: [indexName(parentTable, "created_at")] });
  }
  if (createdBefore) {
    parent.push(sql`t.created_at < ${createdBefore}::timestamptz`);
    clauses.push({ label: "created_before", indexes: [indexName(parentTable, "created_at")] });
  }

  const clampedLimit = Math.min(Math.max(limit, 1), Math.min(limitCap, TABLE_LIMIT_CAP));
  const groupKeys = normalizeGroupBy(groupBy);

  if (groupKeys.length > 0 || aggregate) {
    return compileAggregate(ctx, table, parsed, parent, clauses, {
      groupKeys,
      aggregate: aggregate as AggregateSpec | undefined,
      timeBucket,
      sort,
      limit: clampedLimit,
    });
  }

  const where = sql.join([...parent, ...existsConditions(parsed)], sql` AND `);
  const sorted = compileRecordSort(ctx, sort);
  if (sorted.clause) clauses.push(sorted.clause);
  return {
    kind: "records",
    query: sql`SELECT ${RECORD_COLUMNS} FROM ${table} t WHERE ${where} ORDER BY ${sorted.orderBy} LIMIT ${clampedLimit} OFFSET ${offset}`,
    countQuery: sql`SELECT count(*)::int AS count FROM ${table} t WHERE ${where}`,
    limit: clampedLimit,
    offset,
    fields,
    clauses,
  };
}

function compileAggregate(
  ctx: Ctx,
  table: SQL,
  parsed: ParsedFilter,
  parent: SQL[],
  clauses: Clause[],
  params: { groupKeys: string[]; aggregate?: AggregateSpec; timeBucket?: string; sort?: string; limit: number },
): CompiledQuery {
  const { registry } = ctx;
  const { groupKeys, aggregate, timeBucket, sort, limit } = params;
  const aggs = parseAggregate(aggregate);

  // Which nested array (if any) this aggregation runs over.
  const refs = [...groupKeys, ...aggs.flatMap((a) => (a.field ? [a.field] : []))].map((f) => ({ field: f, parsed: parsePath(registry, ctx.arrayPaths, f) }));
  const nested = refs.filter((r) => r.parsed.kind === "nested") as { field: string; parsed: Extract<ParsedPath, { kind: "nested" }> }[];
  const nestedPaths = new Set(nested.map((r) => r.parsed.path));
  if (nestedPaths.size > 1) {
    throw new Error(`group_by and aggregate can reference one nested array at a time, got: ${[...nestedPaths].join(", ")}`);
  }
  const path = nestedPaths.size === 1 ? [...nestedPaths][0] : null;
  if (path && aggs.some((a) => a.field && parsePath(registry, ctx.arrayPaths, a.field).kind !== "nested")) {
    throw new Error(`Cannot aggregate top-level fields together with fields of '${path}' — aggregate one level at a time`);
  }

  const unwind = path ? findUnwind(registry, path) : undefined;
  const childFilter = path ? parsed.child.get(path) : undefined;
  // The child table serves the query only when every nested field it
  // touches is one of the unwind's columns; otherwise unnest the array.
  const route: "child" | "lateral" | null = !path ? null
    : unwind && nested.every((r) => r.parsed.rest.length === 1 && unwind.fields.some((f) => f.field === r.parsed.rest[0])) ? "child"
    : "lateral";

  const exprsFor = (field: string): FieldExprs => {
    const p = parsePath(registry, ctx.arrayPaths, field);
    if (p.kind === "parent") return parentExprs(registry, field);
    if (p.kind === "object") return objectExprs(registry, p.segments);
    if (route === "child" && unwind) return childExprs(unwind, p.rest[0])!;
    return p.rest.length === 1 ? pathExprs(sql`e.val`, p.rest) : pathExprs(sql`e.val`, p.rest);
  };

  // Grouping keys are referenced by select-list ordinal: the key
  // expressions carry bound parameters (field names), and Postgres would
  // treat a repeated `$n` as a different expression; aliases are ambiguous
  // with real column names such as `status`.
  const select: SQL[] = [];
  const group: number[] = [];
  const defaultOrder: number[] = [];
  const ordinals = new Map<string, number>();
  const add = (expr: SQL, name: string, grouped: boolean) => {
    select.push(expr);
    ordinals.set(name, select.length);
    if (grouped) {
      group.push(select.length);
      defaultOrder.push(select.length);
    }
  };

  if (path) add(sql`t.id AS parent_id`, "parent_id", true);
  if (timeBucket) {
    const bucket = sql.raw(`'${escapeBucket(timeBucket)}'`);
    add(sql`date_trunc(${bucket}, t.created_at) AS time_bucket`, "time_bucket", true);
    defaultOrder.unshift(defaultOrder.pop()!);
  }
  for (const key of groupKeys) {
    const p = parsePath(registry, ctx.arrayPaths, key);
    // Parent fields and nested object paths group as text, like the shared
    // layout; keys of an array element keep their jsonb type.
    const expr = p.kind === "nested" ? exprsFor(key).jsonb : exprsFor(key).text;
    add(sql`${expr} AS ${aliasIdent(key)}`, key, true);
  }
  if (aggs.length === 0) add(sql`count(*)::int AS count`, "count", false);
  for (const a of aggs) {
    if (a.op === "count" || !a.field) add(sql`count(*)::int AS ${aliasIdent(a.alias)}`, a.alias, false);
    else add(sql`${aggregateExpr(a.op, exprsFor(a.field))} AS ${aliasIdent(a.alias)}`, a.alias, false);
  }
  // Group count for the response's `total`, computed in the same statement.
  select.push(sql`count(*) OVER () AS __total`);

  let order: SQL[] = defaultOrder.map((n) => sql`${sql.raw(String(n))} ASC`);
  if (sort) {
    const { field, dir } = parseSort(sort);
    const ordinal = ordinals.get(field);
    if (ordinal === undefined || field === "parent_id") {
      const accepted = [...ordinals.keys()].filter((k) => k !== "parent_id");
      throw new Error(`Invalid sort field '${field}' for an aggregate query — sort accepts an aggregate alias or a group_by key here (${accepted.join(", ")})`);
    }
    order = [sql`${sql.raw(String(ordinal))} ${dir} NULLS LAST`, ...order.filter((_, i) => defaultOrder[i] !== ordinal)];
    clauses.push({ label: `sort on ${field}`, indexes: [] });
  }

  const where: SQL[] = [...parent, ...existsConditions(parsed, route === "child" ? path ?? undefined : undefined)];
  let from: SQL;
  if (route === "child" && unwind) {
    from = sql`${ident(unwind.table)} c JOIN ${table} t ON t.id = c.parent_id`;
    if (childFilter) where.push(...childFilter.conditions);
  } else if (route === "lateral" && path) {
    from = sql`${table} t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.data->${path}::text) = 'array' THEN t.data->${path}::text ELSE '[]'::jsonb END) WITH ORDINALITY e(val, ord)`;
    // Conditions on this path were compiled for the child table (or as
    // jsonpath over the parent); on the unnested element they are the
    // ordinary jsonb conditions over e.val.
    if (childFilter) where.push(...buildFilterConditions(childFilter.raw, sql`e.val`));
  } else {
    from = sql`${table} t`;
  }

  const groupClause = group.length > 0 ? sql`GROUP BY ${sql.raw(group.join(", "))}` : sql``;
  const orderClause = order.length > 0 ? sql`ORDER BY ${sql.join(order, sql`, `)}` : sql``;
  const query = sql`SELECT ${sql.join(select, sql`, `)} FROM ${from} WHERE ${sql.join(where, sql` AND `)} ${groupClause} ${orderClause} LIMIT ${limit}`;

  return {
    kind: "aggregate",
    query,
    limit,
    nested: path && route ? { path, route } : null,
    stripPaths: [...new Set([...registry.unwinds.map((u) => u.path), ...(path ? [path] : [])])],
    clauses,
  };
}

// ── execute ──────────────────────────────────────────────────────────────────

const dialect = new PgDialect();
const explainCache = new Map<string, { report: IndexReport; expires: number }>();
const arrayPathCache = new Map<string, { isArray: boolean; expires: number }>();

/** Render a chunk to SQL text — the query's shape with literals replaced by $n. */
export function renderSql(query: SQL): string {
  return dialect.sqlToQuery(query).sql;
}

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Alias?: string;
  Plans?: PlanNode[];
};

/**
 * Summarize an EXPLAIN (FORMAT JSON) plan against the clauses the caller
 * wrote: indexed only when an index node uses an index that serves one of
 * them. System-side index use (primary keys for joins and ordering, the
 * unique-key index matching `deleted_at IS NULL`) does not count.
 */
export function summarizePlan(root: PlanNode, tablePrefix: string, clauses: Clause[]): IndexReport {
  const used = new Set<string>();
  const scans: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    const type = node["Node Type"];
    if ((type === "Index Scan" || type === "Index Only Scan" || type === "Bitmap Index Scan") && node["Index Name"]) {
      used.add(node["Index Name"]);
      scans.push(node);
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(root);

  const served = clauses.filter((c) => c.indexes.some((i) => used.has(i)));
  if (served.length > 0) {
    const name = served[0].indexes.find((i) => used.has(i))!;
    const node = scans.find((s) => s["Index Name"] === name)!;
    return { indexed: true, plan: `${node["Node Type"]} using ${name}` };
  }

  let scan: PlanNode | undefined;
  const findScan = (node: PlanNode) => {
    if (scan) return;
    if ((node["Relation Name"] ?? "").startsWith(tablePrefix)) {
      scan = node;
      return;
    }
    for (const child of node.Plans ?? []) findScan(child);
  };
  findScan(root);
  const plan = scan ? `${scan["Node Type"]} on ${scan["Relation Name"]}` : root["Node Type"];
  const notes = [...new Set(clauses.flatMap((c) => (c.note ? [c.note] : [])))];
  const reason = clauses.length === 0
    ? "The query has no filter, search or sort to serve; rows were read in storage order."
    : `No index served ${clauses.map((c) => c.label).join(", ")}; evaluated over the stored documents.${notes.map((n) => ` ${n}.`).join("")}`;
  return { indexed: false, plan, reason };
}

async function explain(collectionId: number, query: SQL, clauses: Clause[]): Promise<IndexReport> {
  // Keyed on the clauses too: a default sort and an explicit sort on
  // created_at render to the same SQL but report differently.
  const key = `${collectionId}:${renderSql(query)}:${JSON.stringify(clauses)}`;
  const now = Date.now();
  const cached = explainCache.get(key);
  if (cached && cached.expires > now) return cached.report;
  const result = await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
  const raw = (result.rows[0] as { "QUERY PLAN": unknown })["QUERY PLAN"];
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const root = (parsed as { Plan: PlanNode }[])[0].Plan;
  const report = summarizePlan(root, collectionTableName(collectionId), clauses);
  explainCache.set(key, { report, expires: now + EXPLAIN_TTL_MS });
  if (explainCache.size > 1000) {
    for (const [k, v] of explainCache) if (v.expires <= now) explainCache.delete(k);
  }
  return report;
}

/** First segments of every dotted field the query references. */
function dottedHeads(params: Omit<QueryParams, "collectionId">): string[] {
  const heads = new Set<string>();
  const take = (f: string | undefined) => {
    if (!f) return;
    const name = f.startsWith("-") ? f.slice(1) : f;
    const dot = name.indexOf(".");
    if (dot > 0) heads.add(name.slice(0, dot));
  };
  for (const k of Object.keys(params.filter ?? {})) take(k);
  for (const k of normalizeGroupBy(params.groupBy)) take(k);
  for (const spec of Object.values(params.aggregate ?? {})) {
    if (isPlainObject(spec)) for (const f of Object.values(spec)) if (typeof f === "string") take(f);
  }
  take(params.sort);
  return [...heads];
}

/**
 * Which dotted-field heads hold arrays of objects (as opposed to nested
 * objects). Unwound paths are known from the registry; others are probed
 * with one cached query each.
 */
async function detectArrayPaths(collection: Collection, registry: StorageRegistry, heads: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const table = ident(collectionTableName(collection.id));
  const now = Date.now();
  for (const head of heads) {
    if (findUnwind(registry, head)) continue;
    const key = `${collection.id}:${head}`;
    const cached = arrayPathCache.get(key);
    let isArray: boolean;
    if (cached && cached.expires > now) {
      isArray = cached.isArray;
    } else {
      const r = await db.execute(sql`SELECT 1 FROM ${table} WHERE deleted_at IS NULL AND jsonb_typeof(data->${head}::text) = 'array' LIMIT 1`);
      isArray = r.rows.length > 0;
      arrayPathCache.set(key, { isArray, expires: now + EXPLAIN_TTL_MS });
    }
    if (isArray) out.add(head);
  }
  return out;
}

const sortPathCache = new Map<string, { exists: boolean; expires: number }>();

/**
 * A records-query sort on a field or object path that no live document
 * has (a typo, say) would order by NULLs and silently return storage
 * order; refuse it instead. Projected fields and system columns are known
 * to exist; an empty collection has nothing to check.
 */
async function assertSortPathExists(collection: Collection, registry: StorageRegistry, params: Omit<QueryParams, "collectionId">): Promise<void> {
  const sort = params.sort;
  if (!sort || normalizeGroupBy(params.groupBy).length > 0 || params.aggregate) return;
  const field = sort.startsWith("-") ? sort.slice(1) : sort;
  const segments = field.split(".");
  if (["created_at", "updated_at", "id"].includes(field) || !PATH_RE.test(field) || findProjection(registry, field) || findPathProjection(registry, segments)) return;
  const key = `${collection.id}:${field}`;
  const now = Date.now();
  let exists = sortPathCache.get(key);
  if (!exists || exists.expires <= now) {
    const table = ident(collectionTableName(collection.id));
    const r = await db.execute(sql`
      SELECT (SELECT 1 FROM ${table} WHERE deleted_at IS NULL AND data #> ${pathArray(segments)} IS NOT NULL LIMIT 1) IS NOT NULL AS found,
             (SELECT 1 FROM ${table} WHERE deleted_at IS NULL LIMIT 1) IS NULL AS empty`);
    const row = r.rows[0] as { found: boolean; empty: boolean };
    exists = { exists: row.found || row.empty, expires: now + EXPLAIN_TTL_MS };
    sortPathCache.set(key, exists);
  }
  if (!exists.exists) {
    throw new Error(`Invalid sort field '${field}': no record in this collection has it — ${SORT_HELP}`);
  }
}

export async function queryTable(collection: Collection, params: Omit<QueryParams, "collectionId">): Promise<TableRecordsResult | TableAggregateResult> {
  const registry = readRegistry(collection.storage);
  const arrayPaths = await detectArrayPaths(collection, registry, dottedHeads(params));
  const compiled = compileQuery(collection, params, { arrayPaths });
  await assertSortPathExists(collection, registry, params);

  if (compiled.kind === "aggregate") {
    const [rows, report] = await Promise.all([db.execute(compiled.query), explain(collection.id, compiled.query, compiled.clauses)]);
    const raw = rows.rows as Record<string, unknown>[];
    const total = raw.length > 0 ? Number(raw[0].__total) : 0;
    let results = raw.map(({ __total: _omit, ...rest }) => rest);
    if (compiled.nested && params.record !== false) {
      const ids = [...new Set(results.map((r) => Number(r.parent_id)))];
      const parents = new Map((await fetchEmbeddedRecords(collection.id, ids, params.fields)).map((r) => [r.id, r]));
      results = results.map((r) => ({ ...r, record: parents.get(Number(r.parent_id)) ?? null }));
    }
    return { results, total, count: results.length, limit: compiled.limit, ...report };
  }

  const { query, countQuery, limit, offset, fields } = compiled;
  const [rowsResult, report] = await Promise.all([db.execute(query), explain(collection.id, query, compiled.clauses)]);
  const rows = (rowsResult.rows as Parameters<typeof toRecord>[1][]).map((r) => toRecord(collection.id, r));

  let total: number;
  if (offset === 0 && rows.length < limit) {
    total = rows.length;
  } else {
    const countRows = await db.execute(countQuery);
    total = (countRows.rows[0] as { count: number }).count;
  }

  const projected = fields && fields.length > 0 ? rows.map((r) => ({ ...r, data: projectData(r.data, fields) })) : rows;
  const hasMore = offset + rows.length < total;
  return {
    records: projected,
    total,
    count: rows.length,
    limit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + rows.length : null,
    ...report,
  };
}

/**
 * In-JS equivalent of fetchEmbeddedRecords' slimming (kept for callers
 * that already hold the document): the requested `fields`, or only the
 * top-level scalar values.
 */
export function embeddedRecord(record: TableRecord, fields: string[] | undefined): TableRecord {
  if (!isPlainObject(record.data)) return record;
  if (fields && fields.length > 0) return { ...record, data: projectData(record.data, fields) };
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.data)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") data[k] = v;
  }
  return { ...record, data };
}
