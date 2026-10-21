import { isPlainObject } from "@/lib/validation";
import { ClientInputError } from "@/lib/errors/client-input-error";

/**
 * Response shaping for records: `fields` (which keys of each document to
 * return, including paths into nested objects and arrays of objects) and
 * `array_sort` / `array_limit` (order and cut an embedded array). Both run
 * on documents already fetched; the query engine checks beforehand that
 * every path exists in the collection, so nothing asked for is dropped
 * silently.
 */

const PATH_RE = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Most keys one array_sort entry takes. */
export const MAX_ARRAY_SORT_KEYS = 3;

/** A projection tree: `true` keeps the whole value, a subtree keeps only its keys. */
type FieldTree = Map<string, FieldTree | true>;

/**
 * The tree for a list of fields. A dotted path ("answers.score") descends;
 * a key that is not a valid dotted path is a literal top-level key. A whole
 * key wins over paths below it (["answers", "answers.score"] keeps all of
 * answers); sibling paths combine (["answers.id", "answers.score"]).
 */
function fieldTree(fields: string[]): FieldTree {
  const root: FieldTree = new Map();
  for (const field of fields) {
    const segments = PATH_RE.test(field) ? field.split(".") : [field];
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const existing = node.get(seg);
      if (existing === true) break;
      if (i === segments.length - 1) {
        node.set(seg, true);
        break;
      }
      const next: FieldTree = existing ?? new Map();
      node.set(seg, next);
      node = next;
    }
  }
  return root;
}

function projectObject(data: Record<string, unknown>, tree: FieldTree): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, sub] of tree) {
    if (!Object.hasOwn(data, key)) continue;
    if (sub === true) {
      out[key] = data[key];
      continue;
    }
    const projected = projectValue(data[key], sub);
    if (projected !== undefined) out[key] = projected;
  }
  return out;
}

/**
 * Keys below a value: an object keeps the listed keys; an array keeps its
 * object (and nested array) elements, each reduced to the listed keys, and
 * drops scalar elements, which have no keys; a scalar has nothing below it
 * and is left out (Mongo's projection rules).
 */
function projectValue(value: unknown, tree: FieldTree): unknown {
  if (isPlainObject(value)) return projectObject(value, tree);
  if (Array.isArray(value)) {
    return value.flatMap((el) => {
      const projected = projectValue(el, tree);
      return projected === undefined ? [] : [projected];
    });
  }
  return undefined;
}

/**
 * Keep only the requested keys of a record's data. A top-level key that
 * literally contains dots ("a.b") is kept when the document has it.
 */
export function projectData(data: unknown, fields: string[]): unknown {
  if (!isPlainObject(data)) return data;
  const out = projectObject(data, fieldTree(fields));
  for (const field of fields) {
    if (field.includes(".") && Object.hasOwn(data, field)) out[field] = data[field];
  }
  return out;
}

/** The top-level keys a list of fields needs from each document. */
export function fieldHeads(fields: string[]): string[] {
  return [...new Set(fields.flatMap((f) => (PATH_RE.test(f) ? [f.split(".")[0], ...(f.includes(".") ? [f] : [])] : [f])))];
}

// ── array_sort / array_limit ────────────────────────────────────────────────

export type ArraySortKey = { segments: string[]; descending: boolean };
export type ArrayOps = { path: string; sort: ArraySortKey[]; limit?: number }[];

export const ARRAY_OPS_HELP =
  "array_sort maps the path of an array of objects to sort keys below each element (\"-score\", \"name\", or \"-score,answer_id\"; - for descending, up to 3 keys), " +
  "and array_limit maps the path of an array to how many elements to keep (after array_sort)";

/**
 * Validate and combine array_sort ({path: "-score,id"} or {path: ["-score", "id"]})
 * and array_limit ({path: 10}) into one list of operations per path.
 */
export function parseArrayOps(arraySort: Record<string, unknown> | undefined, arrayLimit: Record<string, unknown> | undefined): ArrayOps {
  const ops = new Map<string, { path: string; sort: ArraySortKey[]; limit?: number }>();
  const entry = (path: string, param: string) => {
    if (!PATH_RE.test(path)) throw new ClientInputError(`Invalid ${param} path '${path}' — ${ARRAY_OPS_HELP}`);
    const op = ops.get(path) ?? { path, sort: [] };
    ops.set(path, op);
    return op;
  };
  for (const [path, spec] of Object.entries(arraySort ?? {})) {
    const raw = typeof spec === "string" ? spec.split(",") : Array.isArray(spec) && spec.every((s) => typeof s === "string") ? spec.flatMap((s: string) => s.split(",")) : null;
    if (!raw) throw new ClientInputError(`array_sort['${path}'] must be a string or an array of strings — ${ARRAY_OPS_HELP}`);
    const keys = raw.map((k) => k.trim());
    if (keys.length > MAX_ARRAY_SORT_KEYS) throw new ClientInputError(`array_sort['${path}'] takes at most ${MAX_ARRAY_SORT_KEYS} keys, got ${keys.length}`);
    const op = entry(path, "array_sort");
    for (const key of keys) {
      const descending = key.startsWith("-");
      const field = descending ? key.slice(1) : key;
      if (!PATH_RE.test(field)) throw new ClientInputError(`Invalid array_sort key '${key}' for '${path}' — ${ARRAY_OPS_HELP}`);
      op.sort.push({ segments: field.split("."), descending });
    }
  }
  for (const [path, n] of Object.entries(arrayLimit ?? {})) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new ClientInputError(`array_limit['${path}'] must be a whole number of elements (0 or more)`);
    entry(path, "array_limit").limit = n;
  }
  return [...ops.values()];
}

/**
 * Rank of a value's type for array_sort: numbers, then strings, then
 * booleans (false < true), then anything else (objects, arrays) in their
 * original order; missing and null always last, in both directions.
 */
function typeRank(v: unknown): number {
  if (typeof v === "number") return 0;
  if (typeof v === "string") return 1;
  if (typeof v === "boolean") return 2;
  return 3;
}

function compareValues(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a as number) - (b as number);
  // Code-point order, not locale order, so results never depend on the server's locale.
  if (ra === 1) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  if (ra === 2) return Number(a) - Number(b);
  return 0;
}

function readPath(value: unknown, segments: string[]): unknown {
  let cur = value;
  for (const seg of segments) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function sortArray(arr: unknown[], keys: ArraySortKey[]): unknown[] {
  const indexed = arr.map((el, i) => ({ el, i }));
  indexed.sort((x, y) => {
    for (const key of keys) {
      const a = readPath(x.el, key.segments);
      const b = readPath(y.el, key.segments);
      const aNull = a === undefined || a === null;
      const bNull = b === undefined || b === null;
      if (aNull || bNull) {
        if (aNull && bNull) continue;
        return aNull ? 1 : -1;
      }
      const c = compareValues(a, b);
      if (c !== 0) return key.descending ? -c : c;
    }
    return x.i - y.i;
  });
  return indexed.map((x) => x.el);
}

/**
 * Apply array_sort/array_limit to one document, returning a new document
 * and, for each array that array_limit cut, its full length (`totals`), so
 * a response can say how many elements there were. A path that does not
 * hold an array in this document is left as it is.
 */
export function applyArrayOps(data: unknown, ops: ArrayOps): { data: unknown; totals: Record<string, number> } {
  const totals: Record<string, number> = {};
  if (ops.length === 0 || !isPlainObject(data)) return { data, totals };
  let out: Record<string, unknown> = data;
  for (const op of ops) {
    const segments = op.path.split(".");
    const arr = readPath(out, segments);
    if (!Array.isArray(arr)) continue;
    let next = op.sort.length > 0 ? sortArray(arr, op.sort) : arr;
    if (op.limit !== undefined && next.length > op.limit) {
      totals[op.path] = next.length;
      next = next.slice(0, op.limit);
    }
    out = setPath(out, segments, next);
  }
  return { data: out, totals };
}

function setPath(obj: Record<string, unknown>, segments: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (rest.length === 0) return { ...obj, [head]: value };
  return { ...obj, [head]: setPath(obj[head] as Record<string, unknown>, rest, value) };
}

/** Whether `fields` (when given) returns the value at `path`, or something below it. */
export function fieldsCover(fields: string[] | undefined, path: string): boolean {
  if (!fields || fields.length === 0) return true;
  return fields.some((f) => f === path || f.startsWith(`${path}.`) || path.startsWith(`${f}.`));
}
