import { db } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  AGGREGATION_OPS,
  escapeBucket,
  isOperatorSpec,
  MAX_GROUP_BY_KEYS,
  normalizeGroupBy,
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
import { applyArrayOps, ARRAY_OPS_HELP, fieldHeads, fieldsCover, parseArrayOps, projectData, type ArrayOps } from "./projection";

/**
 * Query compiler for a collection's hc_<id> table: records, aggregates and
 * time buckets, plus `indexed`/`plan`.
 *
 * Field paths:
 * - `field`            a top-level key (projected column when available)
 * - `a.b.c`            a path through nested objects: its projected column
 *                      when inference made one, else data #> '{a,b,c}'
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
 * sort is the document field, so the primary key never counts.
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

/** Page ceiling: 1,000 rows unless the caller (export) raises limitCap. */
export const DEFAULT_LIMIT_CAP = 1000;
/** Hard ceiling for limitCap. */
export const TABLE_LIMIT_CAP = 10_000;
export { MAX_GROUP_BY_KEYS };
const DEFAULT_LIMIT = 50;
const EXPLAIN_TTL_MS = 60_000;
const IN_LIST_LIMIT = 1000;
const PATH_RE = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Most sort keys one query takes ("-points,name" or ["-points", "name"]). */
export const MAX_SORT_KEYS = 3;

export const SORT_HELP =
  "sort accepts a top-level field, a dotted path into nested objects (a.b.c), created_at or updated_at — " +
  "and with group_by/aggregate, an aggregate alias or a group_by key — optionally prefixed with - for descending; " +
  `up to ${MAX_SORT_KEYS} keys as a comma-separated list or an array, the first deciding first`;

type Collection = { id: number; storage: unknown };

/**
 * QueryParams for a collection table: `sort` may also be an array
 * of keys, and `perRecord` keeps one row per parent record in aggregates
 * over a nested array.
 */
export type TableQueryParams = Omit<QueryParams, "collectionId" | "sort"> & {
  sort?: string | string[];
  /** Aggregates over an array of objects: one row per parent record and group (with `record` attached) instead of totals across parents. */
  perRecord?: boolean;
};

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
  /** Aggregates that came back null for some groups because of the field's value types. */
  warnings?: string[];
} & IndexReport;

/**
 * A clause the caller wrote and the indexes that could serve it. `note`
 * explains a clause no index can serve (an unprojected nested path), and is
 * added to the response's reason when the query is not indexed.
 */
export type Clause = { label: string; indexes: string[]; note?: string };

export type CompiledQuery =
  | {
      kind: "records";
      query: SQL;
      countQuery: SQL;
      limit: number;
      offset: number;
      fields?: string[];
      clauses: Clause[];
      /**
       * A descending sort on a projection column, run in two parts so the
       * column's btree (ASC NULLS LAST) serves it backwards: `query` reads
       * the rows that have a value, then the rows without one follow in id
       * order. Together they are exactly ORDER BY col DESC NULLS LAST, id.
       */
      nullsLast?: { nullRows: (limit: number, offset: number) => SQL; countWithValue: SQL };
    }
  | {
      kind: "aggregate";
      query: SQL;
      limit: number;
      /** Set when rows are per parent record (perRecord), so the parent can be attached. */
      nested: { path: string; route: "child" | "lateral" } | null;
      stripPaths: string[];
      clauses: Clause[];
      /** sum/avg aggregates and the hidden column naming an unsupported value type they met. */
      typeChecks: { alias: string; op: string; field: string; column: string }[];
    };

export type CompileOptions = {
  /** First segments of dotted fields that hold arrays of objects but are not unwound. */
  arrayPaths?: Iterable<string>;
  /** group_by keys (top-level or object paths) that hold arrays of scalars in some document: grouped per element. */
  scalarArrayKeys?: Iterable<string>;
};

// ── Paths ────────────────────────────────────────────────────────────────────

type ParsedPath =
  | { kind: "parent"; field: string }
  | { kind: "object"; segments: string[] }
  | { kind: "nested"; path: string; rest: string[]; unwind?: Unwind };

function parsePath(registry: StorageRegistry, arrayPaths: Set<string>, field: string): ParsedPath {
  // A key that is not a valid dotted path (empty or non-identifier
  // segments) is a literal top-level key.
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
    // a date column only stands in for it while no such value exists. A
    // text column is NULL for over-long strings, which still compare in the
    // document, so it too only answers ranges while it has no misfits.
    if (type === "boolean" || ((type === "date" || type === "text") && mixed)) return null;
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

// ── Document conditions (scalars and arrays of scalars) ──────────────────────

/**
 * Where a field's value sits in a document: a top-level key or a nested
 * object path, below the parent document (`t.data`) or an unnested array
 * element (`e.val`).
 */
type DocTarget = {
  /** The jsonb value at the field; SQL NULL when absent. */
  json: SQL;
  /** Its text form (`->>` / `#>>`). */
  text: SQL;
  /** Containment of `value` at the field: what the GIN serves. */
  contains: (value: unknown) => SQL;
  /** The document column and the field's jsonpath, for `@?` predicates. */
  data: SQL;
  jsonpath: string;
  /** Set for a top-level key: `$exists` tests the key with `?`. */
  key?: string;
};

function keyTarget(data: SQL, key: string): DocTarget {
  return {
    json: sql`${data}->${key}::text`,
    text: sql`${data}->>${key}::text`,
    contains: (value) => sql`${data} @> ${JSON.stringify({ [key]: value })}::jsonb`,
    data,
    jsonpath: `$${jsonpathKey(key)}`,
    key,
  };
}

function pathTarget(data: SQL, segments: string[]): DocTarget {
  return {
    json: sql`${data} #> ${pathArray(segments)}`,
    text: sql`${data} #>> ${pathArray(segments)}`,
    contains: (value) => sql`${data} @> ${JSON.stringify(nestValue(segments, value))}::jsonb`,
    data,
    jsonpath: `$${segments.map(jsonpathKey).join("")}`,
  };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function likePattern(operand: string): string {
  return `%${operand.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function assertOperand(op: string, operand: unknown): void {
  if (Object.hasOwn(COMPARISONS, op)) {
    if (typeof operand !== "number" && typeof operand !== "string") throw new Error(`${op} requires a number or string operand`);
  } else if (op === "$in" || op === "$nin") {
    if (!Array.isArray(operand)) throw new Error(`${op} requires an array operand`);
    if (operand.length > IN_LIST_LIMIT) throw new Error(`$in/$nin arrays are limited to ${IN_LIST_LIMIT} elements`);
  } else if (op === "$exists") {
    if (typeof operand !== "boolean") throw new Error("$exists requires a boolean operand");
  } else if (op === "$contains") {
    if (typeof operand !== "string") {
      throw new Error("$contains requires a string operand (a case-insensitive substring). To match array elements exactly use {\"field\": \"value\"}, {\"field\": {\"$in\": [...]}}, or {\"field\": [\"a\", \"b\"]} for all of them");
    }
  } else if (op !== "$ne") {
    throw new Error(`Unsupported filter operator '${op}'. Supported: $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $contains`);
  }
}

/**
 * A positive condition on one jsonb value (a field's value, or one element
 * of an array held there): equality (op null), comparisons, $in and
 * $contains. Comparisons and $contains only see values of the operand's
 * type.
 */
function valueMatch(json: SQL, text: SQL, op: string | null, operand: unknown): SQL {
  if (op === null) return sql`${json} = ${JSON.stringify(operand)}::jsonb`;
  if (Object.hasOwn(COMPARISONS, op)) {
    const cmp = sql.raw(COMPARISONS[op]);
    return typeof operand === "number"
      ? sql`(jsonb_typeof(${json}) = 'number' AND (${text})::numeric ${cmp} ${operand})`
      : sql`(jsonb_typeof(${json}) = 'string' AND (${text}) ${cmp} ${operand})`;
  }
  if (op === "$in") {
    const list = operand as unknown[];
    if (list.length === 0) return sql`false`;
    return sql`${json} = ANY(ARRAY[${sql.join(list.map((v) => sql`${JSON.stringify(v)}::jsonb`), sql`, `)}])`;
  }
  if (op === "$contains") return sql`(jsonb_typeof(${json}) = 'string' AND (${text}) ILIKE ${likePattern(operand as string)})`;
  throw new Error(`valueMatch: unexpected operator ${op}`);
}

/** Some element of the array held at the target matches (false when it holds no array). */
function anyElement(t: DocTarget, op: string | null, operand: unknown): SQL {
  const el = sql`arr_el.v`;
  return sql`(jsonb_typeof(${t.json}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${t.json}) AS arr_el(v) WHERE ${valueMatch(el, sql`${el} #>> '{}'`, op, operand)}))`;
}

/** $in as one jsonpath predicate: lax mode tests a scalar and each element of an array alike, and the GIN serves it. */
function inJsonpath(t: DocTarget, list: unknown[]): SQL | null {
  const lits = list.map(jsonpathLiteral);
  if (lits.length === 0 || lits.some((l) => l === null)) return null;
  return sql`${t.data} @? ${`${t.jsonpath} ? (${lits.map((l) => `@ == ${l}`).join(" || ")})`}::jsonpath`;
}

type Compiled = { condition: SQL; indexable: boolean };

/**
 * One filter condition evaluated over the document, with Mongo semantics
 * for arrays of scalars: a value matches a field holding an array when
 * some element matches (equality, $in, comparisons, $contains), and $ne /
 * $nin match when no element does (or the field is absent). An object or
 * array operand keeps plain containment ({"tags": ["a", "b"]} needs both).
 */
function documentCondition(t: DocTarget, op: string | null, operand: unknown): Compiled {
  if (op !== null) assertOperand(op, operand);
  if (op === null || op === "$ne") {
    const match = isScalar(operand) ? sql`(${t.contains(operand)} OR ${t.contains([operand])})` : t.contains(operand);
    return op === null ? { condition: match, indexable: true } : { condition: sql`NOT ${match}`, indexable: false };
  }
  if (op === "$in" || op === "$nin") {
    const list = operand as unknown[];
    if (list.length === 0) return { condition: op === "$in" ? sql`false` : sql`true`, indexable: false };
    const viaPath = inJsonpath(t, list);
    const match = viaPath ?? sql`coalesce(${valueMatch(t.json, t.text, "$in", list)} OR ${anyElement(t, "$in", list)}, false)`;
    return op === "$in" ? { condition: match, indexable: viaPath !== null } : { condition: sql`NOT ${match}`, indexable: false };
  }
  if (op === "$exists") {
    const present = t.key !== undefined ? sql`${t.data} ? ${t.key}::text` : sql`${t.json} IS NOT NULL`;
    return { condition: operand ? present : sql`NOT (${present})`, indexable: false };
  }
  // Comparisons and $contains.
  return { condition: sql`(${valueMatch(t.json, t.text, op, operand)} OR ${anyElement(t, op, operand)})`, indexable: false };
}

/**
 * A condition on a field that has a projection column. The column answers
 * exactly when the literal has the column's type and, for a projection
 * flagged `mixed` (some document holds another type there, such as an
 * array), together with the array elements the column cannot see.
 * Returns null when the column can't help; the caller uses the document.
 */
function projectedCondition(t: DocTarget, column: SQL, projection: Projection, op: string | null, operand: unknown): SQL | null {
  if (op === "$exists") {
    // Without misfits every present value fits the column, so presence is NOT NULL.
    if (projection.mixed || typeof operand !== "boolean") return null;
    return operand ? sql`${column} IS NOT NULL` : sql`${column} IS NULL`;
  }
  const routed = columnCondition(column, projection.type, op, operand, projection.mixed);
  if (!routed || !projection.mixed) return routed;
  if (op === "$ne" || op === "$nin") {
    const positive = op === "$ne" ? null : "$in";
    return sql`(${routed} AND NOT ${anyElement(t, positive, operand)})`;
  }
  const elements = op === null && isScalar(operand) ? t.contains([operand]) : anyElement(t, op, operand);
  return sql`(${routed} OR ${elements})`;
}

// ── Filter compilation ───────────────────────────────────────────────────────

type ChildGroup = {
  unwind: Unwind;
  conditions: SQL[];
};

type ParsedFilter = {
  /** Conditions on the parent table alias `t`. */
  parent: SQL[];
  /** Per unwound path: child-column conditions (for EXISTS / child aggregates). */
  child: Map<string, ChildGroup>;
  /** Per array path: every condition on it as a filter over one element (key = path below the element). */
  nestedRaw: Map<string, Record<string, unknown>>;
  /** Array paths with a condition no child column can serve. */
  unrouted: Set<string>;
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
  const { registry, parent: parentTable } = ctx;
  const parent: SQL[] = [];
  const child = new Map<string, ChildGroup>();
  const clauses: Clause[] = [];
  const data = sql`t.data`;
  // Dotted conditions that could not use a child column, grouped by their
  // first segment so they compile to one jsonpath predicate per path.
  const leftovers = new Map<string, PathCondition[]>();
  const nestedRaw = new Map<string, Record<string, unknown>>();
  const uniqueKey = registry.unique_key ?? [];

  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$")) {
      parent.push(logicalCondition(ctx, key, value, clauses));
      continue;
    }
    const parsed = parsePath(registry, ctx.arrayPaths, key);

    if (parsed.kind === "object") {
      parent.push(...fieldConditions(ctx, key, pathTarget(data, parsed.segments), findPathProjection(registry, parsed.segments), value, clauses, unprojectedNote(key)));
      continue;
    }

    if (parsed.kind === "nested") {
      const { path, rest, unwind } = parsed;
      const column = rest.length === 1 ? unwind?.fields.find((f) => f.field === rest[0]) : undefined;
      const raw = nestedRaw.get(path) ?? {};
      raw[rest.join(".")] = value;
      nestedRaw.set(path, raw);
      for (const cond of entries(value)) {
        // Child columns carry no misfit flag; a text one may be NULL for an
        // over-long string, so it never answers a range.
        const routed = unwind && column ? columnCondition(sql`c.${ident(column.column)}`, column.type, cond.op, cond.operand, column.type === "text") : null;
        if (routed && unwind && column) {
          const group = child.get(path) ?? { unwind, conditions: [] };
          group.conditions.push(routed);
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

    // Equality on a unique-key field compares the uk_<n> generated column,
    // which the partial unique index serves.
    const projection = findProjection(registry, key);
    if (!isOperatorSpec(value) && uniqueKey.includes(key) && value !== undefined && !(projection && valueFitsType(projection.type, value))) {
      parent.push(sql`t.${ident(`uk_${uniqueKey.indexOf(key)}`)} = ${JSON.stringify(value)}::jsonb`);
      clauses.push({ label: `filter on ${key}`, indexes: [`${parentTable}_uk`] });
      continue;
    }
    parent.push(...fieldConditions(ctx, key, keyTarget(data, key), projection, value, clauses));
  }

  for (const [path, conds] of leftovers) {
    parent.push(...jsonpathConditions(data, path, conds));
    for (const c of conds) {
      clauses.push({
        label: `filter on ${[path, ...c.segments].join(".")}${c.op ? ` (${c.op})` : ""}`,
        indexes: jsonpathIndexable([c]) ? [ctx.gin] : [],
      });
    }
  }
  return { parent, child, nestedRaw, unrouted: new Set(leftovers.keys()), clauses };
}

export const LOGICAL_OPERATORS = ["$and", "$or"] as const;

/**
 * `$or` / `$and` at the top of a filter (or nested inside one another):
 * a non-empty array of filters, each compiled like a whole filter into one
 * self-contained condition on the record (array conditions inside a branch
 * become that branch's EXISTS or jsonpath test), then joined with OR / AND.
 * Branch conditions select records; they do not restrict which elements
 * of an array an aggregate runs over.
 */
function logicalCondition(ctx: Ctx, key: string, value: unknown, clauses: Clause[]): SQL {
  if (!(LOGICAL_OPERATORS as readonly string[]).includes(key)) {
    throw new Error(`Unsupported top-level filter operator '${key}'. Supported: ${LOGICAL_OPERATORS.join(", ")} (each takes an array of filters, e.g. {"$or": [{"status": "open"}, {"score": {"$gt": 10}}]}); field operators ($gt, $in, ...) go inside a field: {"score": {"$gt": 10}}`);
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((b) => isPlainObject(b))) {
    throw new Error(`${key} takes a non-empty array of filters, e.g. {"${key}": [{"status": "open"}, {"score": {"$gt": 10}}]}`);
  }
  const branches = value.map((branch) => {
    const sub = compileFilter(ctx, branch as Record<string, unknown>);
    clauses.push(...sub.clauses);
    const conds = [...sub.parent, ...existsConditions(sub)];
    return conds.length === 0 ? sql`true` : sql`(${sql.join(conds, sql` AND `)})`;
  });
  return sql`(${sql.join(branches, key === "$or" ? sql` OR ` : sql` AND `)})`;
}

/** {a: {b: {c: value}}} for path [a, b, c]: the containment shape of a nested equality. */
function nestValue(segments: string[], value: unknown): Record<string, unknown> {
  return segments.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>;
}

function unprojectedNote(field: string): string {
  return `'${field}' is a nested object path with no projection`;
}

function mixedNote(field: string): string {
  return `'${field}' holds values of more than one type, so its projection cannot order or range-compare them like the documents do`;
}

/**
 * Conditions on a top-level key or a nested object path. Each condition
 * uses the field's projection column where the column comparison means
 * the same as the document's; otherwise the document (documentCondition).
 * `note` explains an unprojected nested path in the response's reason.
 */
function fieldConditions(ctx: Ctx, key: string, target: DocTarget, projection: Projection | undefined, value: unknown, clauses: Clause[], note?: string): SQL[] {
  const out: SQL[] = [];
  for (const cond of entries(value)) {
    const label = `filter on ${key}${cond.op ? ` (${cond.op})` : ""}`;
    const routed = projection ? projectedCondition(target, sql`t.${ident(projection.column)}`, projection, cond.op, cond.operand) : null;
    if (routed && projection) {
      out.push(routed);
      const indexes = [indexName(ctx.parent, projection.column), ...(projection.mixed && cond.op === null ? [ctx.gin] : [])];
      clauses.push({ label, indexes });
      continue;
    }
    const compiled = documentCondition(target, cond.op, cond.operand);
    out.push(compiled.condition);
    clauses.push({ label, indexes: compiled.indexable ? [ctx.gin] : [], ...(note && !projection ? { note } : {}) });
  }
  return out;
}

/**
 * The lateral route's conditions on one unnested element (`e.val`), same
 * semantics as on a document; keys are paths below the element.
 */
function elementConditions(raw: Record<string, unknown>): SQL[] {
  return Object.entries(raw).flatMap(([key, value]) => {
    const segments = key.split(".");
    const target = segments.length > 1 ? pathTarget(sql`e.val`, segments) : keyTarget(sql`e.val`, key);
    return entries(value).map((c) => documentCondition(target, c.op, c.operand).condition);
  });
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

/**
 * The sort keys of a query: one key, a comma-separated list ("-points,name")
 * or an array, at most MAX_SORT_KEYS. Field paths never contain commas, so
 * splitting on them is unambiguous.
 */
export function sortKeys(sort: string | string[] | undefined): string[] {
  if (sort === undefined) return [];
  const raw = Array.isArray(sort) ? sort.flatMap((s) => s.split(",")) : sort.split(",");
  const keys = raw.map((k) => k.trim());
  if (keys.length === 1 && keys[0] === "") return [];
  const bad = keys.find((k) => k === "" || k === "-");
  if (bad !== undefined) throw new Error(`Invalid sort field '${bad}' in '${Array.isArray(sort) ? sort.join(",") : sort}' — ${SORT_HELP}`);
  if (keys.length > MAX_SORT_KEYS) throw new Error(`sort takes at most ${MAX_SORT_KEYS} keys, got ${keys.length}`);
  return keys;
}

function parseSort(sort: string): { field: string; dir: SQL; descending: boolean } {
  const descending = sort.startsWith("-");
  const field = descending ? sort.slice(1) : sort;
  if (!field) throw new Error(`Invalid sort field '${sort}' — ${SORT_HELP}`);
  return { field, dir: descending ? sql`DESC` : sql`ASC`, descending };
}

type SortKey = { orderBy: SQL; clause?: Clause; tiebreak?: SQL; descendingColumn?: SQL };

function compileRecordSort(ctx: Ctx, keys: string[]): { orderBy: SQL; clauses: Clause[]; descendingColumn?: SQL } {
  if (keys.length <= 1) {
    const { tiebreak, clause, ...sorted } = compileRecordSortKey(ctx, keys[0]);
    // Ties (equal values, same-batch created_at) break on the row id so a
    // page of top-N results is the same every time: in the sort's direction
    // for created_at, updated_at and id, else ascending.
    return { ...sorted, clauses: clause ? [clause] : [], orderBy: sql`${sorted.orderBy}, ${tiebreak ?? (keys[0] ? sql`t.id ASC` : sql`t.id DESC`)}` };
  }
  // Several keys: each in turn, then the row id. Only the first key can
  // use its index, and only for an ascending sort (best effort).
  const compiled = keys.map((k) => compileRecordSortKey(ctx, k));
  return {
    orderBy: sql`${sql.join(compiled.map((c) => c.orderBy), sql`, `)}, t.id ASC`,
    clauses: compiled.flatMap((c) => (c.clause ? [c.clause] : [])),
  };
}

function compileRecordSortKey(ctx: Ctx, sort: string | undefined): SortKey {
  if (!sort) return { orderBy: sql`t.created_at DESC` };
  const { field, dir } = parseSort(sort);
  const sameDir = sql`t.id ${dir}`;
  const { registry, parent } = ctx;
  // `id` is a document field here (the row id is not addressable by filter
  // or sort), so the primary key never serves a caller's clause.
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
      const column = sql`t.${ident(projection.column)}`;
      return { orderBy: sql`${column} ${dir} NULLS LAST`, clause: { label, indexes: [indexName(parent, projection.column)] }, ...(sort.startsWith("-") ? { descendingColumn: column } : {}) };
    }
    // `#>` keeps jsonb typing so numbers order numerically.
    return {
      orderBy: sql`t.data #> ${pathArray(parsed.segments)} ${dir} NULLS LAST`,
      clause: { label, indexes: [], note: projection ? mixedNote(field) : unprojectedNote(field) },
    };
  }
  const projection = findProjection(registry, field);
  if (projection && !projection.mixed) {
    const column = sql`t.${ident(projection.column)}`;
    return {
      orderBy: sql`${column} ${dir} NULLS LAST`,
      clause: { label, indexes: [indexName(parent, projection.column)] },
      ...(sort.startsWith("-") ? { descendingColumn: column } : {}),
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

/**
 * Expressions for one field in a given source (parent columns, child
 * columns or a lateral element):
 * - numeric: numbers only (min/max)
 * - sumable: numbers, and booleans as 1 (true) / 0 (false) (sum/avg)
 * - boolean: booleans only (min/max over a boolean field)
 * - text, jsonb: the value as text and as jsonb
 * - group: the group_by key, keeping its JSON type
 * - typed: the source holds only numbers or booleans (a typed column), so sum/avg need no type check
 */
type FieldExprs = { numeric: SQL; sumable: SQL; boolean: SQL; text: SQL; jsonb: SQL; group: SQL; typed?: boolean };

/**
 * A float8 projection column as numeric for sum/avg/min/max. Through text,
 * not ::numeric: float8 -> numeric keeps 15 digits, while the shortest text
 * form (extra_float_digits >= 1, the default) is the decimal the document
 * holds, so a sum over the column equals the sum over the documents.
 */
function exactNumeric(column: SQL): SQL {
  return sql`${column}::text::numeric`;
}

/** Expressions over a jsonb value `json` (with text form `text`) read from a document or element. */
function documentExprs(json: SQL, text: SQL): FieldExprs {
  return {
    numeric: sql`CASE WHEN jsonb_typeof(${json}) = 'number' THEN (${text})::numeric END`,
    sumable: sql`CASE jsonb_typeof(${json}) WHEN 'number' THEN (${text})::numeric WHEN 'boolean' THEN CASE WHEN (${json})::boolean THEN 1 ELSE 0 END END`,
    boolean: sql`CASE WHEN jsonb_typeof(${json}) = 'boolean' THEN (${json})::boolean END`,
    text,
    jsonb: json,
    group: json,
  };
}

/**
 * Use a projection column where it reads the same as the document: numbers
 * always (a column never holds a value the document doesn't, and misfits
 * aren't numbers); sums of booleans and group keys only while no other
 * value type is stored at the field.
 */
function withProjection(exprs: FieldExprs, projection: Projection | undefined): FieldExprs {
  if (!projection) return exprs;
  const col = sql`t.${ident(projection.column)}`;
  const out = { ...exprs };
  if (projection.type === "number") out.numeric = exactNumeric(col);
  if (projection.type === "boolean") out.boolean = col;
  if (!projection.mixed) {
    if (projection.type === "number") out.sumable = exactNumeric(col);
    if (projection.type === "boolean") out.sumable = sql`${col}::int::numeric`;
    out.group = sql`to_jsonb(${col})`;
    out.typed = projection.type === "number" || projection.type === "boolean";
  }
  return out;
}

function parentExprs(registry: StorageRegistry, field: string): FieldExprs {
  return withProjection(documentExprs(sql`t.data->${field}::text`, sql`t.data->>${field}::text`), findProjection(registry, field));
}

/** A nested object path: from its projection where it has one, else from the document. */
function objectExprs(registry: StorageRegistry, segments: string[]): FieldExprs {
  return withProjection(pathExprs(sql`t.data`, segments), findPathProjection(registry, segments));
}

/** `src #> '{...}'` expressions for a path below a document or an element. */
function pathExprs(src: SQL, segments: string[]): FieldExprs {
  const arr = pathArray(segments);
  return documentExprs(sql`${src} #> ${arr}`, sql`${src} #>> ${arr}`);
}

function childExprs(unwind: Unwind, key: string): FieldExprs | null {
  const f = unwind.fields.find((x) => x.field === key);
  if (!f) return null;
  const col = sql`c.${ident(f.column)}`;
  return {
    numeric: f.type === "number" ? exactNumeric(col) : sql`NULL::numeric`,
    sumable: f.type === "number" ? exactNumeric(col) : f.type === "boolean" ? sql`${col}::int::numeric` : sql`NULL::numeric`,
    boolean: f.type === "boolean" ? col : sql`NULL::boolean`,
    text: f.type === "text" ? col : sql`${col}::text`,
    jsonb: sql`to_jsonb(${col})`,
    group: sql`to_jsonb(${col})`,
    typed: f.type === "number" || f.type === "boolean",
  };
}

/**
 * min/max take numbers first, then booleans (false < true), then text, so
 * a boolean field gives a boolean and a numeric field a number. sum/avg
 * add numbers and count booleans as 1/0 (so sum of a flag is how many are
 * true and avg the share that are).
 */
function aggregateExpr(op: string, f: FieldExprs, firstOrder: SQL): SQL {
  const present = sql`${f.jsonb} IS NOT NULL AND ${f.jsonb} <> 'null'::jsonb`;
  switch (op) {
    case "count":
      // {"count": "path"}: rows (or elements) in the group with a value at the path.
      return sql`(count(*) FILTER (WHERE ${present}))::int`;
    case "first":
      // Any one value from the group, chosen deterministically: the first
      // non-null value in row id order (then element order within a record).
      return sql`(array_agg(${f.jsonb} ORDER BY ${firstOrder}) FILTER (WHERE ${present}))[1]`;
    case "min":
    case "max": {
      const fn = sql.raw(op);
      const bool = sql.raw(op === "min" ? "bool_and" : "bool_or");
      return sql`coalesce(to_jsonb(${fn}(${f.numeric})), to_jsonb(${bool}(${f.boolean})), to_jsonb(${fn}(${f.text})))`;
    }
    case "distinct":
      return sql`array_agg(distinct ${f.text})`;
    case "sum":
    case "avg":
      return sql`to_jsonb(${sql.raw(op)}(${f.sumable}))`;
    default:
      throw new Error(`Unsupported aggregation '${op}'. Supported: ${AGGREGATION_OPS}`);
  }
}

export const AGGREGATE_SPEC_EXAMPLE = '{"rows": "count", "voters": {"count": "votes.bill_id"}, "points": {"sum": "votes.points.veterans"}, "name": {"first": "name"}}';

/**
 * An aggregate spec: alias -> "count" (rows in the group), or {op: field}.
 * {"count": "path"} counts rows (or array elements) with a non-null value
 * at the path; {"count": "*"} (or any non-path operand) is "count".
 */
function parseAggregate(aggregate: AggregateSpec | undefined): { alias: string; op: string; field: string | null }[] {
  if (!aggregate) return [];
  return Object.entries(aggregate).map(([alias, spec]) => {
    if (spec === "count") return { alias, op: "count", field: null };
    const entries = isPlainObject(spec) ? Object.entries(spec) : [];
    if (entries.length !== 1) {
      const label = typeof spec === "string" ? spec : JSON.stringify(spec);
      throw new Error(`Unsupported aggregation '${label}' for '${alias}'. Each alias takes "count" or one {op: field} with op one of ${AGGREGATION_OPS}, e.g. ${AGGREGATE_SPEC_EXAMPLE}`);
    }
    const [op, field] = entries[0];
    if (op === "count") {
      return typeof field === "string" && field !== "*" && field !== "" ? (assertPathName(field), { alias, op, field }) : { alias, op, field: null };
    }
    if (typeof field !== "string") throw new Error(`Aggregation '${op}' for '${alias}' takes a field name, e.g. {"${op}": "score"}`);
    assertPathName(field);
    return { alias, op, field };
  });
}

// ── compile ──────────────────────────────────────────────────────────────────

export function compileQuery(collection: Collection, params: TableQueryParams, options: CompileOptions = {}): CompiledQuery {
  const registry = readRegistry(collection.storage);
  const parentTable = collectionTableName(collection.id);
  const ctx: Ctx = {
    registry,
    arrayPaths: new Set(options.arrayPaths ?? []),
    parent: parentTable,
    gin: indexName(parentTable, "data_gin"),
  };
  const table = ident(parentTable);
  const { filter, search, fields, createdAfter, createdBefore, limit = DEFAULT_LIMIT, offset = 0, groupBy, aggregate, timeBucket, limitCap = DEFAULT_LIMIT_CAP } = params;
  const keys = sortKeys(params.sort);

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
      sortKeys: keys,
      limit: clampedLimit,
      perRecord: params.perRecord === true,
      scalarArrayKeys: new Set(options.scalarArrayKeys ?? []),
    });
  }

  const where = sql.join([...parent, ...existsConditions(parsed)], sql` AND `);
  const sorted = compileRecordSort(ctx, keys);
  clauses.push(...sorted.clauses);
  const countQuery = sql`SELECT count(*)::int AS count FROM ${table} t WHERE ${where}`;
  const column = sorted.descendingColumn;
  if (column) {
    return {
      kind: "records",
      query: sql`SELECT ${RECORD_COLUMNS} FROM ${table} t WHERE ${where} AND ${column} IS NOT NULL ORDER BY ${column} DESC, t.id ASC LIMIT ${clampedLimit} OFFSET ${offset}`,
      countQuery,
      limit: clampedLimit,
      offset,
      fields,
      clauses,
      nullsLast: {
        nullRows: (limit, nullOffset) => sql`SELECT ${RECORD_COLUMNS} FROM ${table} t WHERE ${where} AND ${column} IS NULL ORDER BY t.id ASC LIMIT ${limit} OFFSET ${nullOffset}`,
        countWithValue: sql`SELECT count(*)::int AS count FROM ${table} t WHERE ${where} AND ${column} IS NOT NULL`,
      },
    };
  }
  return {
    kind: "records",
    query: sql`SELECT ${RECORD_COLUMNS} FROM ${table} t WHERE ${where} ORDER BY ${sorted.orderBy} LIMIT ${clampedLimit} OFFSET ${offset}`,
    countQuery,
    limit: clampedLimit,
    offset,
    fields,
    clauses,
  };
}

/**
 * The WHERE conditions (on alias `t`, live rows only) that a filter
 * compiles to, for statements other than a query: transform's set_field.
 */
export function compileFilterWhere(collection: Collection, filter: Record<string, unknown>, options: CompileOptions = {}): SQL {
  const registry = readRegistry(collection.storage);
  const parentTable = collectionTableName(collection.id);
  const ctx: Ctx = { registry, arrayPaths: new Set(options.arrayPaths ?? []), parent: parentTable, gin: indexName(parentTable, "data_gin") };
  const parsed = compileFilter(ctx, filter);
  return sql.join([sql`t.deleted_at IS NULL`, ...parsed.parent, ...existsConditions(parsed)], sql` AND `);
}

/**
 * Aggregates. Semantics over arrays:
 * - a group_by key holding an array of scalars (tags) groups per element:
 *   each record counts once in the group of every element it holds; a
 *   record without the key, or with an empty array, lands in the null group.
 * - group_by or aggregate on a path into an array of objects ("votes.vote")
 *   runs over the elements: one row per group value, totalled across
 *   parents. Parent fields may be grouped and aggregated alongside; a parent
 *   value then counts once per element. perRecord keeps one row per parent
 *   record and group (parent_id, with the parent attached as `record`).
 */
function compileAggregate(
  ctx: Ctx,
  table: SQL,
  parsed: ParsedFilter,
  parent: SQL[],
  clauses: Clause[],
  params: { groupKeys: string[]; aggregate?: AggregateSpec; timeBucket?: string; sortKeys: string[]; limit: number; perRecord: boolean; scalarArrayKeys: Set<string> },
): CompiledQuery {
  const { registry } = ctx;
  const { groupKeys, aggregate, timeBucket, sortKeys: keys, limit, perRecord, scalarArrayKeys } = params;
  const aggs = parseAggregate(aggregate);

  // Which nested array (if any) this aggregation runs over.
  const refs = [...groupKeys, ...aggs.flatMap((a) => (a.field ? [a.field] : []))].map((f) => ({ field: f, parsed: parsePath(registry, ctx.arrayPaths, f) }));
  const nested = refs.filter((r) => r.parsed.kind === "nested") as { field: string; parsed: Extract<ParsedPath, { kind: "nested" }> }[];
  const nestedPaths = new Set(nested.map((r) => r.parsed.path));
  if (nestedPaths.size > 1) {
    throw new Error(`group_by and aggregate can reference one nested array at a time, got: ${[...nestedPaths].join(", ")}`);
  }
  const path = nestedPaths.size === 1 ? [...nestedPaths][0] : null;

  const unwind = path ? findUnwind(registry, path) : undefined;
  const childFilter = path ? parsed.child.get(path) : undefined;
  // The child table serves the query only when every nested field it
  // touches (group, aggregate and filter) is one of the unwind's columns;
  // otherwise unnest the array. Either way, conditions on the array apply
  // to each element aggregated, not just to the parent.
  // count-with-path and first read the element's own value, which a child
  // column does not hold when it has another type (the column is NULL), so
  // they unnest the array.
  const readsElementValue = aggs.some((a) => a.field && (a.op === "first" || a.op === "count") && parsePath(registry, ctx.arrayPaths, a.field).kind === "nested");
  const route: "child" | "lateral" | null = !path ? null
    : unwind && !parsed.unrouted.has(path) && !readsElementValue && nested.every((r) => r.parsed.rest.length === 1 && unwind.fields.some((f) => f.field === r.parsed.rest[0])) ? "child"
    : "lateral";

  const exprsFor = (field: string): FieldExprs => {
    const p = parsePath(registry, ctx.arrayPaths, field);
    if (p.kind === "parent") return parentExprs(registry, field);
    if (p.kind === "object") return objectExprs(registry, p.segments);
    if (route === "child" && unwind) return childExprs(unwind, p.rest[0])!;
    return pathExprs(sql`e.val`, p.rest);
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

  // Scalar arrays grouped per element: one lateral unnest per such key.
  const unnests: SQL[] = [];

  if (path && perRecord) add(sql`t.id AS parent_id`, "parent_id", true);
  if (timeBucket) {
    const bucket = sql.raw(`'${escapeBucket(timeBucket)}'`);
    add(sql`date_trunc(${bucket}, t.created_at) AS time_bucket`, "time_bucket", true);
    defaultOrder.unshift(defaultOrder.pop()!);
  }
  for (const key of groupKeys) {
    const p = parsePath(registry, ctx.arrayPaths, key);
    let expr: SQL;
    if (p.kind !== "nested" && scalarArrayKeys.has(key)) {
      const json = exprsFor(key).jsonb;
      const alias = sql.raw(`g${unnests.length}`);
      unnests.push(sql`LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${json}) = 'array' AND jsonb_array_length(${json}) > 0 THEN ${json} ELSE jsonb_build_array(CASE WHEN jsonb_typeof(${json}) = 'array' THEN NULL ELSE ${json} END) END) AS ${alias}(val)`);
      expr = sql`${alias}.val`;
    } else {
      expr = exprsFor(key).group;
    }
    // Keys keep their JSON type (a number comes back as a number); a JSON
    // null and a missing key are the same null group.
    add(sql`NULLIF(${expr}, 'null'::jsonb) AS ${aliasIdent(key)}`, key, true);
  }
  if (aggs.length === 0) add(sql`count(*)::int AS count`, "count", false);
  const typeChecks: { alias: string; op: string; field: string; column: string }[] = [];
  const firstOrder = route === "lateral" ? sql`t.id, e.ord` : route === "child" ? sql`t.id, c.idx` : sql`t.id`;
  for (const a of aggs) {
    if (!a.field) {
      add(sql`count(*)::int AS ${aliasIdent(a.alias)}`, a.alias, false);
      continue;
    }
    const exprs = exprsFor(a.field);
    add(sql`${aggregateExpr(a.op, exprs, firstOrder)} AS ${aliasIdent(a.alias)}`, a.alias, false);
    if ((a.op === "sum" || a.op === "avg") && !exprs.typed) {
      const column = `__type_${typeChecks.length}`;
      select.push(sql`min(jsonb_typeof(${exprs.jsonb})) FILTER (WHERE jsonb_typeof(${exprs.jsonb}) IN ('string', 'array', 'object')) AS ${sql.raw(`"${column}"`)}`);
      typeChecks.push({ alias: a.alias, op: a.op, field: a.field, column });
    }
  }
  // Group count for the response's `total`, computed in the same statement.
  select.push(sql`count(*) OVER () AS __total`);

  let order: SQL[] = defaultOrder.map((n) => sql`${sql.raw(String(n))} ASC`);
  if (keys.length > 0) {
    const chosen: number[] = [];
    const first: SQL[] = [];
    for (const key of keys) {
      const { field, dir } = parseSort(key);
      const ordinal = ordinals.get(field);
      if (ordinal === undefined || field === "parent_id") {
        const accepted = [...ordinals.keys()].filter((k) => k !== "parent_id");
        throw new Error(`Invalid sort field '${field}' for an aggregate query — sort accepts an aggregate alias or a group_by key here (${accepted.join(", ")})`);
      }
      first.push(sql`${sql.raw(String(ordinal))} ${dir} NULLS LAST`);
      chosen.push(ordinal);
      clauses.push({ label: `sort on ${field}`, indexes: [] });
    }
    order = [...first, ...order.filter((_, i) => !chosen.includes(defaultOrder[i]))];
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
    // ordinary document conditions over e.val.
    const raw = parsed.nestedRaw.get(path);
    if (raw) where.push(...elementConditions(raw));
  } else {
    from = sql`${table} t`;
  }
  if (unnests.length > 0) from = sql`${from}, ${sql.join(unnests, sql`, `)}`;

  const groupClause = group.length > 0 ? sql`GROUP BY ${sql.raw(group.join(", "))}` : sql``;
  const orderClause = order.length > 0 ? sql`ORDER BY ${sql.join(order, sql`, `)}` : sql``;
  const query = sql`SELECT ${sql.join(select, sql`, `)} FROM ${from} WHERE ${sql.join(where, sql` AND `)} ${groupClause} ${orderClause} LIMIT ${limit}`;

  return {
    kind: "aggregate",
    query,
    limit,
    nested: path && route && perRecord ? { path, route } : null,
    stripPaths: [...new Set([...registry.unwinds.map((u) => u.path), ...(path ? [path] : [])])],
    clauses,
    typeChecks,
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
  // An index scan that serves none of the caller's clauses (the default
  // created_at order, the live-row unique index) is named as such, so the
  // plan never reads as indexed when `indexed` is false.
  const viaIndex = scan?.["Index Name"];
  const plan = !scan ? root["Node Type"]
    : viaIndex ? `${scan["Node Type"]} using ${viaIndex} on ${scan["Relation Name"]}, serving none of the query's clauses`
    : `${scan["Node Type"]} on ${scan["Relation Name"]}`;
  const notes = [...new Set(clauses.flatMap((c) => (c.note ? [c.note] : [])))];
  const how = viaIndex ? `${viaIndex} only supplied row order or the live-row check, and the clauses were evaluated over the stored documents` : "evaluated over the stored documents";
  const reason = clauses.length === 0
    ? "The query has no filter, search or sort to serve; rows were read in storage order."
    : `No index served ${clauses.map((c) => c.label).join(", ")}; ${how}.${notes.map((n) => ` ${n}.`).join("")}`;
  return { indexed: false, plan, reason };
}

async function explain(collectionId: number, query: SQL, clauses: Clause[]): Promise<IndexReport> {
  // Keyed on the clauses too: a default sort and an explicit sort on
  // created_at render to the same SQL but report differently. And on the
  // bound values: the plan for LIMIT 10 is not the plan for OFFSET 5000.
  const { sql: text, params } = dialect.sqlToQuery(query);
  const key = `${collectionId}:${text}:${JSON.stringify(params)}:${JSON.stringify(clauses)}`;
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
function dottedHeads(params: TableQueryParams): string[] {
  const heads = new Set<string>();
  const take = (f: string | undefined) => {
    if (!f) return;
    const name = f.startsWith("-") ? f.slice(1) : f;
    const dot = name.indexOf(".");
    if (dot > 0) heads.add(name.slice(0, dot));
  };
  const filterKeys = (filter: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith("$")) {
        if (Array.isArray(v)) for (const branch of v) if (isPlainObject(branch)) filterKeys(branch);
      } else {
        take(k);
      }
    }
  };
  filterKeys(params.filter ?? {});
  for (const k of normalizeGroupBy(params.groupBy)) take(k);
  for (const spec of Object.values(params.aggregate ?? {})) {
    if (isPlainObject(spec)) for (const f of Object.values(spec)) if (typeof f === "string") take(f);
  }
  for (const k of sortKeys(params.sort)) take(k);
  return [...heads];
}

const scalarArrayCache = new Map<string, { isArray: boolean; expires: number }>();

/**
 * group_by keys (top-level keys or nested object paths) that hold an array
 * in some live document, so the aggregate groups per element. A projection
 * without misfits proves the field never holds an array; others are probed
 * with one cached query each.
 */
async function detectScalarArrayKeys(collection: Collection, registry: StorageRegistry, arrayPaths: Set<string>, params: TableQueryParams): Promise<Set<string>> {
  const out = new Set<string>();
  const table = ident(collectionTableName(collection.id));
  const now = Date.now();
  for (const key of normalizeGroupBy(params.groupBy)) {
    const parsed = parsePath(registry, arrayPaths, key);
    if (parsed.kind === "nested") continue;
    const segments = parsed.kind === "object" ? parsed.segments : [key];
    const projection = parsed.kind === "object" ? findPathProjection(registry, segments) : findProjection(registry, key);
    if (projection && !projection.mixed) continue;
    const cacheKey = `${collection.id}:${JSON.stringify(segments)}`;
    const cached = scalarArrayCache.get(cacheKey);
    let isArray: boolean;
    if (cached && cached.expires > now) {
      isArray = cached.isArray;
    } else {
      const r = await db.execute(sql`SELECT 1 FROM ${table} WHERE deleted_at IS NULL AND jsonb_typeof(data #> ${pathArray(segments)}) = 'array' LIMIT 1`);
      isArray = r.rows.length > 0;
      scalarArrayCache.set(cacheKey, { isArray, expires: now + EXPLAIN_TTL_MS });
    }
    if (isArray) out.add(key);
  }
  return out;
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

/**
 * WHERE conditions (alias `t`, live rows) for a filter outside a query,
 * with the same array detection a query does: transform's set_field.filter.
 */
export async function tableFilterWhere(collection: Collection, filter: Record<string, unknown>): Promise<SQL> {
  const registry = readRegistry(collection.storage);
  const heads = dottedHeads({ filter });
  const arrayPaths = await detectArrayPaths(collection, registry, heads);
  return compileFilterWhere(collection, filter, { arrayPaths });
}

const sortPathCache = new Map<string, { exists: boolean; expires: number }>();

/**
 * A records-query sort on a field or object path that no live document
 * has (a typo, say) would order by NULLs and silently return storage
 * order; refuse it instead. Projected fields and system columns are known
 * to exist; an empty collection has nothing to check.
 */
async function assertSortPathExists(collection: Collection, registry: StorageRegistry, params: TableQueryParams): Promise<void> {
  if (normalizeGroupBy(params.groupBy).length > 0 || params.aggregate) return;
  for (const key of sortKeys(params.sort)) await assertSortKeyExists(collection, registry, key);
}

async function assertSortKeyExists(collection: Collection, registry: StorageRegistry, sort: string): Promise<void> {
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

const fieldPathCache = new Map<string, { exists: boolean; expires: number }>();

/**
 * Whether some live document has a value at `field` (lax jsonpath, so a
 * path through an array of objects, "answers.score", counts when some
 * element has it), or `asArray`: holds an array at that object path. A
 * top-level key that literally contains dots also counts. Projected
 * fields are known to exist; an empty collection has nothing to check.
 */
async function pathExists(collection: Collection, registry: StorageRegistry, field: string, asArray = false): Promise<boolean> {
  const segments = field.split(".");
  if (!asArray) {
    if (findProjection(registry, field) || (segments.length > 1 && findPathProjection(registry, segments))) return true;
    const unwind = segments.length === 2 ? findUnwind(registry, segments[0]) : undefined;
    if (unwind?.fields.some((f) => f.field === segments[1])) return true;
  }
  const key = `${collection.id}:${asArray ? "array" : "path"}:${field}`;
  const now = Date.now();
  const cached = fieldPathCache.get(key);
  if (cached && cached.expires > now) return cached.exists;
  const table = ident(collectionTableName(collection.id));
  const test = asArray
    ? sql`jsonb_typeof(data #> ${pathArray(segments)}) = 'array'`
    : sql`(data @? ${`lax $${segments.map(jsonpathKey).join("")}`}::jsonpath OR data ? ${field}::text)`;
  const r = await db.execute(sql`
    SELECT (SELECT 1 FROM ${table} WHERE deleted_at IS NULL AND ${test} LIMIT 1) IS NOT NULL AS found,
           (SELECT 1 FROM ${table} WHERE deleted_at IS NULL LIMIT 1) IS NULL AS empty`);
  const row = r.rows[0] as { found: boolean; empty: boolean };
  const exists = row.found || row.empty;
  fieldPathCache.set(key, { exists, expires: now + EXPLAIN_TTL_MS });
  return exists;
}

/**
 * `fields`, `array_sort` and `array_limit` shape returned documents, so
 * every path they name must be one some record has: a typo or a path the
 * data doesn't hold is an error, never an empty response.
 */
async function assertShapingPaths(collection: Collection, registry: StorageRegistry, fields: string[] | undefined, arrayOps: ArrayOps): Promise<void> {
  for (const field of fields ?? []) {
    if (typeof field !== "string" || field === "") throw new Error("fields must be a list of field names or dotted paths");
    const segments = field.split(".");
    if (segments.length > 1 && !PATH_RE.test(field)) {
      throw new Error(`Invalid field '${field}' — fields takes top-level keys or dotted paths ("answers.score") whose segments are letters, numbers and underscores`);
    }
    if (!(await pathExists(collection, registry, field))) {
      throw new Error(`Invalid field '${field}' in fields: no record in this collection has it. fields takes top-level keys and dotted paths into objects or arrays of objects ("answers.score"); run hutch_describe_collection to see the fields.`);
    }
  }
  for (const op of arrayOps) {
    if (!fieldsCover(fields, op.path)) throw new Error(`'${op.path}' in array_sort/array_limit is not returned by fields — add it (or a path below it) to fields`);
    if (!(await pathExists(collection, registry, op.path, true))) {
      throw new Error(`Invalid array_sort/array_limit path '${op.path}': no record in this collection holds an array there — ${ARRAY_OPS_HELP}`);
    }
    for (const key of op.sort) {
      const full = [op.path, ...key.segments].join(".");
      if (!(await pathExists(collection, registry, full))) {
        throw new Error(`Invalid array_sort key '${key.segments.join(".")}' for '${op.path}': no element in this collection has it`);
      }
    }
  }
}

/** array_sort/array_limit, then fields, on one returned document. */
function shapeData(data: unknown, fields: string[] | undefined, arrayOps: ArrayOps): unknown {
  const ordered = applyArrayOps(data, arrayOps);
  return fields && fields.length > 0 ? projectData(ordered, fields) : ordered;
}

export async function queryTable(collection: Collection, params: TableQueryParams): Promise<TableRecordsResult | TableAggregateResult> {
  const registry = readRegistry(collection.storage);
  const arrayPaths = await detectArrayPaths(collection, registry, dottedHeads(params));
  const scalarArrayKeys = await detectScalarArrayKeys(collection, registry, arrayPaths, params);
  const compiled = compileQuery(collection, params, { arrayPaths, scalarArrayKeys });
  await assertSortPathExists(collection, registry, params);
  const arrayOps = parseArrayOps(params.arraySort, params.arrayLimit);
  const fieldsGiven = (params.fields ?? []).length > 0;
  if (compiled.kind === "aggregate" && (fieldsGiven || arrayOps.length > 0) && !(compiled.nested && params.record !== false)) {
    throw new Error("fields, array_sort and array_limit shape returned records: they apply to a records query, or to the `record` attached to each row of a per_record aggregate. An aggregate's columns are its group_by keys and aggregate aliases.");
  }
  await assertShapingPaths(collection, registry, params.fields, arrayOps);

  if (compiled.kind === "aggregate") {
    const [rows, report] = await Promise.all([db.execute(compiled.query), explain(collection.id, compiled.query, compiled.clauses)]);
    const raw = rows.rows as Record<string, unknown>[];
    const total = raw.length > 0 ? Number(raw[0].__total) : 0;
    const hidden = new Set(["__total", ...compiled.typeChecks.map((c) => c.column)]);
    const warnings = typeCheckWarnings(compiled.typeChecks, raw);
    let results = raw.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.has(k))));
    if (compiled.nested && params.record !== false) {
      const ids = [...new Set(results.map((r) => Number(r.parent_id)))];
      // Without fields the record carries its top-level scalars, plus any array array_sort/array_limit names.
      const extra = [...new Set(arrayOps.map((op) => op.path.split(".")[0]))];
      const fetched = await fetchEmbeddedRecords(collection.id, ids, fieldsGiven ? fieldHeads(params.fields!) : undefined, extra);
      const parents = new Map(fetched.map((r) => [r.id, fieldsGiven || arrayOps.length > 0 ? { ...r, data: shapeData(r.data, params.fields, arrayOps) } : r]));
      results = results.map((r) => ({ ...r, record: parents.get(Number(r.parent_id)) ?? null }));
    }
    return { results, total, count: results.length, limit: compiled.limit, ...report, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  const { query, countQuery, limit, offset, fields, nullsLast } = compiled;
  const [rowsResult, report] = await Promise.all([db.execute(query), explain(collection.id, query, compiled.clauses)]);
  const rows = (rowsResult.rows as Parameters<typeof toRecord>[1][]).map((r) => toRecord(collection.id, r));

  if (nullsLast && rows.length < limit) {
    // The rows with a value ran out on this page: continue with the rows
    // without one. Their offset is the page offset minus how many rows have
    // a value, which this page tells us unless it came back empty.
    const withValue = rows.length > 0 || offset === 0
      ? offset + rows.length
      : ((await db.execute(nullsLast.countWithValue)).rows[0] as { count: number }).count;
    const more = await db.execute(nullsLast.nullRows(limit - rows.length, Math.max(0, offset - withValue)));
    rows.push(...(more.rows as Parameters<typeof toRecord>[1][]).map((r) => toRecord(collection.id, r)));
  }

  let total: number;
  if (offset === 0 && rows.length < limit) {
    total = rows.length;
  } else {
    const countRows = await db.execute(countQuery);
    total = (countRows.rows[0] as { count: number }).count;
  }

  const projected = fieldsGiven || arrayOps.length > 0 ? rows.map((r) => ({ ...r, data: shapeData(r.data, fields, arrayOps) })) : rows;
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
 * sum/avg add numbers and booleans. A group whose values at the field are
 * all of another type (strings, arrays, objects) would come back null with
 * no explanation: when that is every returned group the query fails naming
 * the type, otherwise each such aggregate gets a warning.
 */
export function typeCheckWarnings(checks: { alias: string; op: string; field: string; column: string }[], rows: Record<string, unknown>[]): string[] {
  const warnings: string[] = [];
  for (const check of checks) {
    const bad = rows.filter((r) => r[check.alias] == null && typeof r[check.column] === "string");
    if (bad.length === 0) continue;
    const types = [...new Set(bad.map((r) => r[check.column] as string))].join(", ");
    const what = `${check.op} '${check.alias}' over '${check.field}'`;
    if (bad.length === rows.length) {
      throw new Error(`${what} found ${types} values and nothing it can add: sum and avg take numbers, and booleans count as 1 (true) and 0 (false). Use count with a filter, or min/max/distinct, for other types.`);
    }
    warnings.push(`${what} is null in ${bad.length} of ${rows.length} groups, whose values are ${types}: sum and avg take numbers and booleans only.`);
  }
  return warnings;
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
