import { inferFieldType } from "./schema-inference";
import { ISO_DATE, URL_RE } from "./constants";

type FieldInfo = {
  name: string;
  type: string;
  types?: string[];
  conflict?: boolean;
  frequency: number;
  sampleValues?: unknown[];
  distinctCount?: number;
  min?: unknown;
  max?: unknown;
  avg?: number;
  avgLength?: number;
  earliest?: string;
  latest?: string;
};

export async function describeCollection(collectionId: number, totalRecords: number): Promise<FieldInfo[]> {
  if (totalRecords === 0) return [];

  const sampleSize = Math.min(totalRecords, 500);
  const { sampleDocuments } = await import("./storage/rows");
  const sampleRecords = (await sampleDocuments(collectionId, sampleSize, true)).map((data) => ({ data }));

  const fieldStats: Record<string, {
    count: number;
    types: Set<string>;
    values: unknown[];
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
          numericValues: [],
          stringLengths: [],
          dateValues: [],
        };
      }
      const stat = fieldStats[key];
      stat.count++;

      const type = inferSingleType(value);
      stat.types.add(type);

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

    // Use the schema-inference engine for richer type detection
    const { type: inferredType } = inferFieldType(stat.values, name);

    const field: FieldInfo = {
      name,
      type: inferredType || primaryType,
      frequency: Math.round(frequency * 100) / 100,
      sampleValues: stat.values.slice(0, 3).map((v) => truncateSample(v)),
    };

    if (types.length > 1) {
      field.types = types;
      field.conflict = true;
    }

    const uniqueValues = new Set(stat.values.map(v => JSON.stringify(v)));
    field.distinctCount = uniqueValues.size;

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

  return fields;
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
