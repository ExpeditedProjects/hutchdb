import { inferFieldType } from "./schema-inference";
import { ISO_DATE, URL_RE } from "./constants";

type FieldInfo = {
  name: string;
  type: string;
  types?: string[];
  conflict?: boolean;
  frequency: number;
  sampleValues?: unknown[];
  /** Exact number of distinct values over every live record (collections up to EXACT_DISTINCT_MAX_RECORDS records and rows.fullScanMaxBytes of documents). */
  distinctCount?: number;
  /** Larger collections, indexed fields only: Postgres's planner estimate (pg_stats, scaled to live records), not a count. */
  distinctCountEstimate?: number;
  /** With conflict: how many sampled records hold each JSON type at this field. */
  typeCounts?: Record<string, number>;
  min?: unknown;
  max?: unknown;
  avg?: number;
  avgLength?: number;
  earliest?: string;
  latest?: string;
};

/**
 * Collections up to this many records (and up to rows.fullScanMaxBytes of
 * documents: counting reads every document) get exact distinct counts;
 * larger ones an estimate for indexed fields.
 */
export const EXACT_DISTINCT_MAX_RECORDS = 20_000;

/** Fields one describe call lists by default (most common first); the rest page with fields_offset. */
export const DESCRIBE_FIELDS_PAGE = 60;

export type DescribePage = {
  /** Skip this many fields of the (prefix-filtered) list, most common first. */
  offset?: number;
  /** Only fields whose name starts with this. */
  prefix?: string;
  /** Page size; DESCRIBE_FIELDS_PAGE by default. */
  limit?: number;
};

export type DescribedFields = {
  fields: FieldInfo[];
  /** Distinct fields seen in the sample. */
  total: number;
  /** Fields matching the prefix (total without one). */
  matched: number;
  offset: number;
};

/**
 * Field names, types and samples from a sample of up to 500 records, most
 * common first, one page at a time: a wide sparse collection can have
 * thousands of fields, and listing all of them made describe too large for
 * a client to accept. Distinct counts are computed for the returned page only.
 */
export async function describeFields(collectionId: number, totalRecords: number, storage: unknown, page: DescribePage = {}): Promise<DescribedFields> {
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  if (totalRecords === 0) return { fields: [], total: 0, matched: 0, offset };

  const sampleSize = Math.min(totalRecords, 500);
  const { sampleDocuments } = await import("./storage/rows");
  const sampleRecords = (await sampleDocuments(collectionId, sampleSize, true, totalRecords)).map((data) => ({ data }));

  const fieldStats: Record<string, {
    count: number;
    types: Set<string>;
    values: unknown[];
    /** Per JSON type: how many records, and up to 5 values. */
    byType: Record<string, { count: number; values: unknown[] }>;
    numericValues: number[];
    stringLengths: number[];
    dateValues: string[];
  }> = {};

  for (const record of sampleRecords) {
    const data = record.data as Record<string, unknown>;
    if (!data || typeof data !== "object") continue;

    for (const [key, value] of Object.entries(data)) {
      if (!fieldStats[key]) {
        fieldStats[key] = {
          count: 0,
          types: new Set(),
          values: [],
          byType: {},
          numericValues: [],
          stringLengths: [],
          dateValues: [],
        };
      }
      const stat = fieldStats[key];
      stat.count++;

      const type = inferSingleType(value);
      stat.types.add(type);
      const slot = (stat.byType[type] ??= { count: 0, values: [] });
      slot.count++;
      if (slot.values.length < 5) slot.values.push(value);

      if (stat.values.length < 5) {
        stat.values.push(value);
      }

      if (type === "number" && typeof value === "number") {
        stat.numericValues.push(value);
      }

      if (type === "string" && typeof value === "string") {
        stat.stringLengths.push(value.length);
      }

      if (type === "date" && typeof value === "string") {
        stat.dateValues.push(value);
      }
    }
  }

  const fields: FieldInfo[] = [];

  for (const [name, stat] of Object.entries(fieldStats)) {
    const types = Array.from(stat.types);
    const primaryType = types.length === 1 ? types[0] : getMostCommonType(types);
    const frequency = stat.count / sampleSize;

    // Use the schema-inference engine for richer type detection. When
    // records disagree on the type, infer from the values of the most
    // common one, so `type` agrees with what most records hold (and with
    // a projection made for it) instead of whichever came first.
    const nonNullTypes = types.filter((t) => t !== "null");
    const majority = nonNullTypes.length > 1
      ? nonNullTypes.reduce((a, b) => (stat.byType[b].count > stat.byType[a].count ? b : a))
      : null;
    const { type: inferredType } = inferFieldType(majority ? stat.byType[majority].values : stat.values, name);

    const field: FieldInfo = {
      name,
      type: inferredType || primaryType,
      frequency: Math.round(frequency * 100) / 100,
      sampleValues: stat.values.slice(0, 3).map((v) => truncateSample(v)),
    };

    if (types.length > 1) {
      field.types = types;
      field.conflict = true;
      if (majority) field.typeCounts = Object.fromEntries(types.map((t) => [t, stat.byType[t].count]));
    }

    if (stat.numericValues.length > 0) {
      field.min = Math.min(...stat.numericValues);
      field.max = Math.max(...stat.numericValues);
      field.avg = Math.round((stat.numericValues.reduce((a, b) => a + b, 0) / stat.numericValues.length) * 100) / 100;
    }

    if (stat.stringLengths.length > 0) {
      field.avgLength = Math.round(stat.stringLengths.reduce((a, b) => a + b, 0) / stat.stringLengths.length);
    }

    if (stat.dateValues.length > 0) {
      stat.dateValues.sort();
      field.earliest = stat.dateValues[0];
      field.latest = stat.dateValues[stat.dateValues.length - 1];
    }

    fields.push(field);
  }

  fields.sort((a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name));
  const matching = page.prefix ? fields.filter((f) => f.name.startsWith(page.prefix!)) : fields;
  const limit = Math.max(0, Math.floor(page.limit ?? DESCRIBE_FIELDS_PAGE));
  const pageFields = matching.slice(offset, offset + limit);

  // Distinct counts for the page's scalar fields (arrays and objects have none).
  const pageNames = new Set(pageFields.map((f) => f.name));
  const scalarKeys = Object.entries(fieldStats)
    .filter(([name, stat]) => pageNames.has(name) && ![...stat.types].some((t) => t === "array" || t === "object"))
    .map(([name]) => name);
  const { exactDistinctCounts, estimatedDistinctCounts, tableBytes, fullScanMaxBytes } = await import("./storage/rows");
  if (totalRecords <= EXACT_DISTINCT_MAX_RECORDS && scalarKeys.length > 0 && await tableBytes(collectionId) <= fullScanMaxBytes()) {
    const counts = await exactDistinctCounts(collectionId, scalarKeys);
    for (const field of pageFields) if (counts[field.name] !== undefined) field.distinctCount = counts[field.name];
  } else {
    const counts = await estimatedDistinctCounts(collectionId, storage, scalarKeys, totalRecords);
    for (const field of pageFields) if (counts[field.name] !== undefined) field.distinctCountEstimate = counts[field.name];
  }

  return { fields: pageFields, total: fields.length, matched: matching.length, offset };
}

/** Longest sample string describe returns; longer ones end in an ellipsis. */
export const MAX_SAMPLE_STRING = 200;
/** Array elements and object keys a sample keeps before summarizing the rest. */
const MAX_SAMPLE_ITEMS = 3;
const MAX_SAMPLE_DEPTH = 3;

/**
 * A sample value small enough to show: strings over MAX_SAMPLE_STRING are
 * cut with an ellipsis, arrays keep their first few elements plus a
 * "… N more" marker, objects their first few keys plus a "…" key, and
 * anything nested deeper than MAX_SAMPLE_DEPTH becomes "…".
 */
export function truncateSample(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_SAMPLE_STRING ? `${value.slice(0, MAX_SAMPLE_STRING)}…` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_SAMPLE_DEPTH) return "…";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_SAMPLE_ITEMS).map((v) => truncateSample(v, depth + 1));
    return value.length > MAX_SAMPLE_ITEMS ? [...kept, `… ${value.length - MAX_SAMPLE_ITEMS} more`] : kept;
  }
  const keys = Object.keys(value);
  const limit = depth === 0 ? Math.max(MAX_SAMPLE_ITEMS, 8) : MAX_SAMPLE_ITEMS;
  const out: Record<string, unknown> = {};
  for (const k of keys.slice(0, limit)) out[k] = truncateSample((value as Record<string, unknown>)[k], depth + 1);
  if (keys.length > limit) out["…"] = `${keys.length - limit} more keys`;
  return out;
}

function inferSingleType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) return "date";
    if (URL_RE.test(value)) return "url";
    return "string";
  }
  return "unknown";
}

function getMostCommonType(types: string[]): string {
  const nonNull = types.filter(t => t !== "null");
  return nonNull[0] || types[0];
}
