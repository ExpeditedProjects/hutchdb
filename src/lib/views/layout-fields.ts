// Which fields a view needs to be published. No db imports: the Cloud
// dashboard imports this in client components.
import type { ViewType } from "./types";

/**
 * Config keys naming the field each view type's layout uses, in the order
 * readers prefer them: kanban reads the dashboard's groupField before the
 * MCP's groupByField. Timeline has only a start date (dateField).
 */
export const LAYOUT_FIELD_KEYS: Partial<Record<ViewType, readonly string[]>> = {
  kanban: ["groupField", "groupByField"],
  calendar: ["dateField"],
  timeline: ["dateField"],
  gallery: ["imageField"],
};

/**
 * The layout keys of a stored view type. A type is any stored string, so
 * only the map's own keys count ("constructor" or "__proto__" have none).
 */
export function layoutFieldKeys(type: string | null | undefined): readonly string[] {
  if (!type || !Object.hasOwn(LAYOUT_FIELD_KEYS, type)) return [];
  return LAYOUT_FIELD_KEYS[type as ViewType] ?? [];
}

/**
 * The field a view's layout uses: the value of the first of its type's
 * layout keys that is set in config to a non-empty string. Undefined when
 * the type has no layout field or none is set.
 */
export function layoutField(type: string | null | undefined, config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  const cfg = config as Record<string, unknown>;
  for (const key of layoutFieldKeys(type)) {
    const value = Object.hasOwn(cfg, key) ? cfg[key] : undefined;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Field names a published view may show: the saved schema's fields that are not hidden, in schema order. */
export function publishableFields(schema: unknown): string[] {
  const fields = (schema as { fields?: unknown } | null | undefined)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f): f is { name: string; hidden?: unknown } => !!f && typeof f === "object" && typeof f.name === "string" && !f.hidden)
    .map((f) => f.name);
}
