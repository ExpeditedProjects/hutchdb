import { isPlainObject } from "@/lib/validation";
import {
  childTableName,
  findPathProjection,
  findProjection,
  findUnwind,
  uniqueColumnName,
  type Projection,
  type ProjectionType,
  type StorageRegistry,
  type Unwind,
  type UnwindField,
} from "./registry";

/**
 * Fixed inference rules for layout='table' collections. Pure: takes the
 * documents of one batch plus the collection's registry and counts, and
 * returns what to create. apply.ts runs the DDL.
 *
 * - declare: a top-level key present (non-null) in >= PRESENCE_RATIO of the
 *   batch whose values share one JSON type in >= TYPE_RATIO of those; scalar
 *   types only.
 * - project: a declared scalar field once the collection holds
 *   PROJECT_THRESHOLD rows; at most MAX_PROJECTIONS per collection.
 * - nested object scalars ("totals.veterans.points", up to MAX_PATH_DEPTH
 *   keys) are declared and projected by the same presence/type rule and
 *   share the same cap. Top-level fields are chosen first, then paths by
 *   presence, shallower first, then name. Paths below an object with more
 *   distinct keys than MAX_PROJECTIONS are never candidates: such an object
 *   is a map keyed by data (category slugs, dates, ids), and any subset of
 *   its entries would be an arbitrary pick. They still answer every query
 *   over the document.
 * - unwind: a top-level key holding an array of objects in >= PRESENCE_RATIO
 *   of documents whose element keys pass the same declare rule, once the
 *   collection holds UNWIND_THRESHOLD elements under that key; depth one.
 *   The element count is the collection's running total (counted in SQL
 *   after each batch), so an array that crosses the threshold over several
 *   batches is unwound by the batch that crosses it. Creating an unwind
 *   also projects the parent's declared fields. An array that is not
 *   unwound gets a pending entry saying why (below the threshold, too few
 *   documents hold it, mixed element shapes, no declarable element key).
 * - long text (any value over MAX_PROJECTED_TEXT characters in the batch)
 *   is prose, not a key: it is never declared, so it gets no column and no
 *   btree (whose entries are limited to about 2.7 KB).
 */

export const PRESENCE_RATIO = 0.9;
export const TYPE_RATIO = 0.95;
export const MAX_PROJECTIONS = 16;
export const DEFAULT_PROJECT_THRESHOLD = 10_000;
export const DEFAULT_UNWIND_THRESHOLD = 10_000;

export type Thresholds = { project: number; unwind: number };

export function thresholdsFromEnv(env: Record<string, string | undefined> = process.env): Thresholds {
  const parse = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && value !== undefined && value !== "" ? n : fallback;
  };
  return {
    project: parse(env.HUTCH_PROJECT_THRESHOLD, DEFAULT_PROJECT_THRESHOLD),
    unwind: parse(env.HUTCH_UNWIND_THRESHOLD, DEFAULT_UNWIND_THRESHOLD),
  };
}

/** Keys in a nested path that can be projected: two levels of object nesting. */
export const MAX_PATH_DEPTH = 3;

/** Longest text value a declared text field may hold in a batch. */
export const MAX_PROJECTED_TEXT = 256;

/** A path segment queries can address (the dotted-path syntax allows only these). */
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_]+$/;

/** `path` is set for a nested object path; `field` is then its dotted form. */
export type DeclaredField = { field: string; type: ProjectionType; presence: number; path?: string[] };

export type ArrayCandidate = {
  path: string;
  /** Fraction of batch documents holding an array of objects at `path`. */
  presence: number;
  /** Element keys that pass the declare rule across the batch's elements. */
  fields: DeclaredField[];
  /** Elements seen in this batch. */
  batchElements: number;
};

/** An array of objects that is not unwound (yet), and why. */
export type PendingUnwind = { path: string; reason: string };

export type Decisions = {
  projections: Projection[];
  unwinds: Unwind[];
  /** Arrays of objects seen in this batch that were not unwound, with the reason. */
  pending: PendingUnwind[];
};

const STRICT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function scalarType(value: unknown): ProjectionType | null {
  switch (typeof value) {
    case "number": return Number.isFinite(value) ? "number" : null;
    case "boolean": return "boolean";
    case "string": return "text";
    default: return null;
  }
}

/**
 * Declared fields of a set of objects, in descending presence order. Keys
 * containing NUL can't be stored by Postgres and are never declared.
 */
export function declareFields(docs: Record<string, unknown>[]): DeclaredField[] {
  if (docs.length === 0) return [];
  const stats = new Map<string, { present: number; types: Map<string, number>; dates: number; longText: boolean }>();

  for (const doc of docs) {
    if (!isPlainObject(doc)) continue;
    for (const [key, value] of Object.entries(doc)) {
      if (value === null || value === undefined || key.includes("\0")) continue;
      let stat = stats.get(key);
      if (!stat) {
        stat = { present: 0, types: new Map(), dates: 0, longText: false };
        stats.set(key, stat);
      }
      stat.present++;
      const type = scalarType(value) ?? (Array.isArray(value) ? "array" : "object");
      stat.types.set(type, (stat.types.get(type) ?? 0) + 1);
      if (type === "text" && STRICT_DATE_RE.test(value as string)) stat.dates++;
      if (type === "text" && (value as string).length > MAX_PROJECTED_TEXT) stat.longText = true;
    }
  }

  const declared: DeclaredField[] = [];
  for (const [field, stat] of stats) {
    const presence = stat.present / docs.length;
    if (presence < PRESENCE_RATIO) continue;
    let dominant: ProjectionType | null = null;
    for (const [type, count] of stat.types) {
      if (count / stat.present >= TYPE_RATIO && (type === "number" || type === "text" || type === "boolean")) {
        dominant = type;
      }
    }
    if (!dominant || (dominant === "text" && stat.longText)) continue;
    if (dominant === "text" && stat.dates / (stat.types.get("text") ?? 1) >= TYPE_RATIO) dominant = "date";
    declared.push({ field, type: dominant, presence });
  }
  declared.sort((a, b) => b.presence - a.presence || a.field.localeCompare(b.field));
  return declared;
}

type PathStat = { path: string[]; present: number; types: Map<string, number>; dates: number; longText: boolean };

/**
 * Declared nested object scalars of a batch: paths of 2..MAX_PATH_DEPTH
 * keys through plain objects (never through arrays), each passing the same
 * presence and type rule as a top-level field, in descending presence
 * order (then shallower first, then by name). Paths under a map-like object
 * (more than MAX_PROJECTIONS distinct keys across the batch) are skipped.
 */
export function declareNestedFields(docs: Record<string, unknown>[]): DeclaredField[] {
  if (docs.length === 0) return [];
  const stats = new Map<string, PathStat>();
  // Distinct keys seen under each object path, to recognise maps.
  const keysUnder = new Map<string, Set<string>>();

  const visit = (obj: Record<string, unknown>, prefix: string[]) => {
    const prefixKey = prefix.join(".");
    let keys = keysUnder.get(prefixKey);
    if (!keys) {
      keys = new Set();
      keysUnder.set(prefixKey, keys);
    }
    for (const [key, value] of Object.entries(obj)) {
      keys.add(key);
      if (value === null || value === undefined || !PATH_SEGMENT_RE.test(key)) continue;
      const path = [...prefix, key];
      if (isPlainObject(value) && path.length < MAX_PATH_DEPTH) {
        visit(value, path);
        continue;
      }
      const id = path.join(".");
      let stat = stats.get(id);
      if (!stat) {
        stat = { path, present: 0, types: new Map(), dates: 0, longText: false };
        stats.set(id, stat);
      }
      stat.present++;
      const type = scalarType(value) ?? (Array.isArray(value) ? "array" : "object");
      stat.types.set(type, (stat.types.get(type) ?? 0) + 1);
      if (type === "text" && STRICT_DATE_RE.test(value as string)) stat.dates++;
      if (type === "text" && (value as string).length > MAX_PROJECTED_TEXT) stat.longText = true;
    }
  };

  for (const doc of docs) {
    if (!isPlainObject(doc)) continue;
    for (const [key, value] of Object.entries(doc)) {
      if (isPlainObject(value) && PATH_SEGMENT_RE.test(key)) visit(value, [key]);
    }
  }

  const underMap = (path: string[]) => {
    for (let i = 1; i < path.length; i++) {
      if ((keysUnder.get(path.slice(0, i).join("."))?.size ?? 0) > MAX_PROJECTIONS) return true;
    }
    return false;
  };

  const declared: DeclaredField[] = [];
  for (const [field, stat] of stats) {
    const presence = stat.present / docs.length;
    if (presence < PRESENCE_RATIO || underMap(stat.path)) continue;
    let dominant: ProjectionType | null = null;
    for (const [type, count] of stat.types) {
      if (count / stat.present >= TYPE_RATIO && (type === "number" || type === "text" || type === "boolean")) {
        dominant = type;
      }
    }
    if (!dominant || (dominant === "text" && stat.longText)) continue;
    if (dominant === "text" && stat.dates / (stat.types.get("text") ?? 1) >= TYPE_RATIO) dominant = "date";
    declared.push({ field, path: stat.path, type: dominant, presence });
  }
  declared.sort((a, b) => b.presence - a.presence || a.path!.length - b.path!.length || a.field.localeCompare(b.field));
  return declared;
}

function isArrayOfObjects(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isPlainObject);
}

/** Top-level keys that hold an array of objects in enough of the batch. */
export function arrayCandidates(docs: Record<string, unknown>[]): ArrayCandidate[] {
  return surveyArrays(docs).candidates;
}

/**
 * Arrays of objects in a batch: the candidates for unwinding, and the
 * arrays that hold objects but fail the rule, with the reason.
 */
export function surveyArrays(docs: Record<string, unknown>[]): { candidates: ArrayCandidate[]; rejected: PendingUnwind[] } {
  if (docs.length === 0) return { candidates: [], rejected: [] };
  const byPath = new Map<string, { present: number; mixed: number; elements: Record<string, unknown>[] }>();
  for (const doc of docs) {
    if (!isPlainObject(doc)) continue;
    for (const [key, value] of Object.entries(doc)) {
      if (key.includes("\0") || !Array.isArray(value)) continue;
      const objects = value.filter(isPlainObject);
      // Arrays of scalars are not unwound (the GIN serves them); only
      // arrays holding objects are tracked.
      const mixed = objects.length > 0 && objects.length < value.length;
      if (!isArrayOfObjects(value) && !mixed) continue;
      let entry = byPath.get(key);
      if (!entry) {
        entry = { present: 0, mixed: 0, elements: [] };
        byPath.set(key, entry);
      }
      if (mixed) entry.mixed++;
      else {
        entry.present++;
        entry.elements.push(...value);
      }
    }
  }
  const candidates: ArrayCandidate[] = [];
  const rejected: PendingUnwind[] = [];
  for (const [path, entry] of byPath) {
    if (entry.present === 0 && entry.mixed === 0) continue;
    if (entry.elements.length === 0 && entry.mixed === 0) continue; // only empty arrays so far
    const presence = entry.present / docs.length;
    if (presence < PRESENCE_RATIO) {
      rejected.push({
        path,
        reason: entry.mixed > 0
          ? `'${path}' mixes objects with other values in ${entry.mixed} of ${docs.length} documents of the last batch, so it is an array of objects in only ${pct(presence)} of them (needs ${pct(PRESENCE_RATIO)}).`
          : `'${path}' is an array of objects in only ${pct(presence)} of the last batch's documents (needs ${pct(PRESENCE_RATIO)}).`,
      });
      continue;
    }
    const fields = declareFields(entry.elements);
    if (fields.length === 0) {
      rejected.push({ path, reason: `no key of '${path}''s elements is a short scalar present in ${pct(PRESENCE_RATIO)} of elements with one type, so there is nothing to index.` });
      continue;
    }
    candidates.push({ path, presence, fields, batchElements: entry.elements.length });
  }
  candidates.sort((a, b) => b.presence - a.presence || a.path.localeCompare(b.path));
  return { candidates, rejected };
}

export type InferenceInput = {
  collectionId: number;
  docs: Record<string, unknown>[];
  registry: StorageRegistry;
  /** Live rows in the collection after this batch landed. */
  rowCount: number;
  /** Total elements under each candidate path across the whole collection. */
  elementCounts: Record<string, number>;
  thresholds: Thresholds;
};

/**
 * Decide which projections and unwinds to create for this batch. Never
 * returns anything the registry already has.
 */
export function inferDecisions(input: InferenceInput): Decisions {
  const { collectionId, docs, registry, rowCount, elementCounts, thresholds } = input;
  // Top-level fields first: they identify and group parent records (and
  // nested aggregates resolve them); nested paths take the room left.
  const declared = [...declareFields(docs), ...declareNestedFields(docs)];
  const survey = surveyArrays(docs);
  const pending: PendingUnwind[] = survey.rejected.filter((r) => !findUnwind(registry, r.path));

  const unwinds: Unwind[] = [];
  for (const candidate of survey.candidates) {
    if (findUnwind(registry, candidate.path)) continue;
    const total = elementCounts[candidate.path] ?? 0;
    if (total < thresholds.unwind) {
      pending.push({ path: candidate.path, reason: `'${candidate.path}' holds ${total} elements across the collection; it is unwound at ${thresholds.unwind}.` });
      continue;
    }
    const taken: string[] = [];
    const fields: UnwindField[] = candidate.fields.slice(0, MAX_PROJECTIONS).map((f) => {
      const column = uniqueColumnName(f.field, taken);
      taken.push(column);
      return { field: f.field, column, type: f.type };
    });
    unwinds.push({
      path: candidate.path,
      table: childTableName(collectionId, candidate.path),
      fields,
      reason: `'${candidate.path}' is an array of objects in ${pct(candidate.presence)} of documents and holds ${total} elements across the collection (threshold ${thresholds.unwind}).`,
    });
  }

  const projections: Projection[] = [];
  const projectAll = rowCount >= thresholds.project;
  const projectForUnwind = unwinds.length > 0;
  if (projectAll || projectForUnwind) {
    const taken = registry.projections.map((p) => p.column);
    let room = MAX_PROJECTIONS - registry.projections.length;
    for (const f of declared) {
      if (room <= 0) break;
      if (f.path ? findPathProjection(registry, f.path) : findProjection(registry, f.field)) continue;
      const column = uniqueColumnName(f.field, taken);
      taken.push(column);
      room--;
      const why = projectAll
        ? `'${f.field}' is a ${f.type} in ${pct(f.presence)} of documents and the collection reached ${rowCount} rows (threshold ${thresholds.project}).`
        : f.path
          ? `'${f.field}' is a ${f.type} in ${pct(f.presence)} of documents, projected with the parent's fields when a nested array was made queryable.`
          : `'${f.field}' is a ${f.type} in ${pct(f.presence)} of documents and is needed to group nested aggregates by parent record.`;
      projections.push({ field: f.field, ...(f.path ? { path: f.path } : {}), column, type: f.type, reason: why });
    }
  }

  return { projections, unwinds, pending };
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
