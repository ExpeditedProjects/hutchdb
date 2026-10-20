
export {
  SELECTABLE_FIELD_TYPES,
  MAX_OPTION_VALUE_LENGTH,
  MAX_OPTIONS_PER_FIELD,
  isSelectableField,
  type FieldType,
} from "@/lib/schema/field-types";
import type { FieldType } from "@/lib/schema/field-types";

export type FieldDefinition = {
  name: string;
  type: FieldType;
  inferred: boolean;
  position: number;
  hidden: boolean;
  options?: string[]; // for select/multiselect
};

export type CollectionSchema = {
  fields: FieldDefinition[];
  version: number;
  lastInferredAt: string;
};

import { IMAGE_EXTENSIONS, ISO_DATE, EMAIL_RE, URL_RE } from "./constants";

export function inferFieldType(values: unknown[], fieldName?: string): { type: FieldType; options?: string[] } {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (nonNull.length === 0) return { type: "text" };

  // Check if all values are boolean
  if (nonNull.every((v) => typeof v === "boolean")) return { type: "boolean" };

  // Check if all values are numbers
  if (nonNull.every((v) => typeof v === "number")) return { type: "number" };

  // Check if all values are arrays of strings (multiselect)
  if (nonNull.every((v) => Array.isArray(v) && v.every((item) => typeof item === "string"))) {
    return { type: "multiselect" };
  }

  // Check if all values are objects/arrays (json)
  if (nonNull.every((v) => typeof v === "object")) return { type: "json" };

  // String-type detection
  const strings = nonNull.filter((v) => typeof v === "string") as string[];
  if (strings.length === 0) return { type: "json" };

  // Image URL check (before general URL)
  if (strings.every((s) => URL_RE.test(s) && IMAGE_EXTENSIONS.test(s))) {
    return { type: "image_url" };
  }

  // URL check
  if (strings.every((s) => URL_RE.test(s))) return { type: "url" };

  // Email check
  if (strings.every((s) => EMAIL_RE.test(s))) return { type: "email" };

  // Date check
  if (strings.every((s) => ISO_DATE.test(s))) return { type: "date" };

  // Select detection: low-cardinality string fields with at least 2 distinct values
  const distinct = new Set(strings);
  const cardinality = distinct.size / strings.length;
  // Common field names that are typically selects even with few distinct values
  const selectHintNames = ["status", "type", "priority", "severity", "state", "phase", "stage", "tier", "level", "role", "effort", "size", "category"];
  const nameHint = fieldName && selectHintNames.includes(fieldName.toLowerCase());
  // Values longer than 50 chars are almost certainly free-text, not enum options
  const maxLen = Math.max(...Array.from(distinct).map((s) => s.length));
  const isSelect =
    distinct.size < 20 &&
    maxLen <= 50 &&
    (nameHint
      ? distinct.size >= 1 // name-hinted fields need just 1 distinct value
      : distinct.size >= 2 &&
        (strings.length <= 20
          ? distinct.size <= Math.ceil(strings.length * 0.6)
          : cardinality < 0.3));
  if (isSelect) {
    return { type: "select", options: Array.from(distinct).sort() };
  }

  return { type: "text" };
}

export function inferSchemaFromData(dataRows: Record<string, unknown>[]): CollectionSchema {
  const fieldValues: Record<string, unknown[]> = {};

  for (const data of dataRows) {
    if (!data || typeof data !== "object") continue;

    for (const [key, value] of Object.entries(data)) {
      if (!fieldValues[key]) fieldValues[key] = [];
      if (fieldValues[key].length < 200) {
        fieldValues[key].push(value);
      }
    }
  }

  const fields: FieldDefinition[] = [];
  let position = 0;

  // Sort fields by frequency (most common first)
  const sortedKeys = Object.keys(fieldValues).sort(
    (a, b) => fieldValues[b].length - fieldValues[a].length || a.localeCompare(b)
  );

  for (const name of sortedKeys) {
    const { type, options } = inferFieldType(fieldValues[name], name);
    fields.push({
      name,
      type,
      inferred: true,
      position: position++,
      hidden: false,
      ...(options ? { options } : {}),
    });
  }

  return {
    fields,
    version: 1,
    lastInferredAt: new Date().toISOString(),
  };
}

export async function inferSchema(collectionId: number): Promise<CollectionSchema> {
  const { sampleDocuments } = await import("./storage/rows");
  return inferSchemaFromData(await sampleDocuments(collectionId, 500));
}

export function mergeSchema(
  existing: CollectionSchema | null,
  inferred: CollectionSchema
): CollectionSchema {
  if (!existing || !existing.fields || existing.fields.length === 0) {
    return inferred;
  }

  const existingByName = new Map(existing.fields.map((f) => [f.name, f]));
  const merged: FieldDefinition[] = [];
  let maxPosition = Math.max(...existing.fields.map((f) => f.position), -1);
  // If the new inference is empty (no records, or empty data), keep every
  // existing field — otherwise re-inferring an empty collection would nuke
  // the schema.
  const inferenceHasSignal = inferred.fields.length > 0;

  for (const field of existing.fields) {
    if (!field.inferred) {
      // Human-edited field — always preserved.
      merged.push(field);
      continue;
    }
    const newField = inferred.fields.find((f) => f.name === field.name);
    if (newField) {
      merged.push({ ...field, type: newField.type, options: newField.options });
    } else if (!inferenceHasSignal) {
      merged.push(field);
    }
    // else: drop the inferred field — no record contains it anymore.
  }

  // Add newly discovered fields
  for (const field of inferred.fields) {
    if (!existingByName.has(field.name)) {
      merged.push({ ...field, position: ++maxPosition });
    }
  }

  return {
    fields: merged,
    version: (existing.version || 0) + 1,
    lastInferredAt: new Date().toISOString(),
  };
}

export function detectNewFields(
  schema: CollectionSchema | null,
  data: Record<string, unknown>
): boolean {
  if (!schema || !schema.fields || schema.fields.length === 0) return true;
  const knownFields = new Set(schema.fields.map((f) => f.name));
  return Object.keys(data).some((key) => !knownFields.has(key));
}
