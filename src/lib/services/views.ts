import { db } from "@/lib/db";
import { views } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { findAccessibleCollection } from "./resolve";
import { uniqueSlug, titleCase } from "@/lib/slugify";
import { revalidateDashboard } from "@/lib/revalidation";
import { MAX_VIEW_NAME_LENGTH } from "@/lib/views/types";
import { validateTrimmedLength } from "@/lib/validation";
import type { CollectionSchema } from "@/lib/schema-inference";
import { isSelectableField } from "@/lib/schema/field-types";

const TIMESTAMP_FIELD_NAMES = new Set(["created_at", "updated_at"]);

const GROUP_BY_KANBAN_ONLY = { error: "group_by applies to kanban views only", status: 400 };

// ── Publishing ────────────────────────────────────────────────────────────────
//
// A published view is a public read-only page that shows only its columns.
// Publishing therefore needs a non-empty `columns` whose every entry is a
// visible (not hidden) field of the collection's saved schema, so a field
// never becomes public by being added to the data later. This is the one
// place the rule is enforced: the MCP tools and the Cloud dashboard both
// publish through createView/updateView.

/** Most fields an error lists; a wide collection can have thousands. */
const MAX_LISTED_FIELDS = 50;

/**
 * Config keys naming the field each view type's layout needs, in the order
 * readers prefer them (the dashboard's groupField over the MCP's
 * groupByField). Timeline has no end-date key, only dateField.
 */
const LAYOUT_FIELD_KEYS: Record<string, readonly string[]> = {
  kanban: ["groupField", "groupByField"],
  calendar: ["dateField"],
  timeline: ["dateField"],
  gallery: ["imageField"],
};

/** Field names a published view may show: the saved schema's fields that are not hidden. */
function publishableFields(schema: unknown): string[] {
  const fields = (schema as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f): f is { name: string; hidden?: boolean } => !!f && typeof f.name === "string" && f.hidden !== true)
    .map((f) => f.name);
}

function listFields(names: string[]): string {
  const listed = names.slice(0, MAX_LISTED_FIELDS).join(", ");
  const rest = names.length - MAX_LISTED_FIELDS;
  return rest > 0 ? `${listed}, and ${rest} more (hutch_get_collection lists them)` : listed;
}

/** An error when `columns` cannot be published, else null. */
function unpublishableColumns(columns: string[], publishable: string[]): { error: string; status: number } | null {
  if (publishable.length === 0) {
    return {
      error: "This collection has no saved schema fields yet (or all of them are hidden), so its views cannot be published. Save its schema with hutch_infer_schema, or unhide fields with hutch_update_schema, then set columns.",
      status: 400,
    };
  }
  if (columns.length === 0) {
    return {
      error: `Set columns before publishing: a published view shows only the fields listed in its columns. Valid fields: ${listFields(publishable)}.`,
      status: 400,
    };
  }
  const allowed = new Set(publishable);
  const invalid = columns.filter((c) => !allowed.has(c));
  if (invalid.length > 0) {
    return {
      error: `These columns are hidden or not in the collection's saved schema, so they cannot be published: ${listFields(invalid)}. Valid fields: ${listFields(publishable)}.`,
      status: 400,
    };
  }
  return null;
}

/**
 * `columns` plus the field the view's layout needs (kanban group, calendar
 * or timeline date, gallery image) when it is set, publishable and missing.
 * Returns the same array when nothing is added.
 */
function withLayoutField(columns: string[], type: string | null, config: unknown, publishable: string[]): string[] {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const field = (LAYOUT_FIELD_KEYS[type ?? "table"] ?? [])
    .map((key) => cfg[key])
    .find((value): value is string => typeof value === "string" && publishable.includes(value));
  return field && !columns.includes(field) ? [...columns, field] : columns;
}

function storedColumns(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];
}

export async function createView(collectionSlug: string, userId: string, params: {
  type?: string;
  name?: string;
  description?: string;
  filter?: Record<string, unknown>;
  sort?: string;
  columns?: string[];
  config?: Record<string, unknown>;
  groupBy?: string;
  published?: boolean;
}) {
  let resolvedName: string | undefined;
  if (params.name !== undefined) {
    const validated = validateTrimmedLength(params.name, MAX_VIEW_NAME_LENGTH, "Name");
    if ("error" in validated) return validated;
    resolvedName = validated.value;
  }

  const access = await findAccessibleCollection(collectionSlug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  collectionSlug = access.collection.slug;

  const type = params.type || "table";
  if (params.groupBy && type !== "kanban") return GROUP_BY_KANBAN_ONLY;
  const name = resolvedName ?? titleCase(type);

  const config = pickAllowedConfig(params.config ?? {});
  if (params.groupBy) {
    config.groupByField = params.groupBy;
  }

  let columns = params.columns ?? [];
  if (params.published) {
    const publishable = publishableFields(access.collection.schema);
    const invalid = unpublishableColumns(columns, publishable);
    if (invalid) return invalid;
    columns = withLayoutField(columns, type, config, publishable);
  }

  const [created] = await db.insert(views).values({
    collectionId: access.collection.id,
    name,
    slug: uniqueSlug(name),
    type,
    description: params.description || null,
    filter: params.filter ?? {},
    sort: params.sort || null,
    columns,
    config,
    published: params.published ?? false,
  }).returning();

  revalidateDashboard(collectionSlug, "views");
  return { view: created, slug: collectionSlug };
}

/** A view's id, or its slug within the collection. */
export type ViewRef = number | string;

function viewRefCondition(collectionId: number, viewRef: ViewRef) {
  return and(
    typeof viewRef === "number" ? eq(views.id, viewRef) : eq(views.slug, viewRef),
    eq(views.collectionId, collectionId),
  );
}

/** Same access rule as createView; the view must belong to collectionSlug. */
async function findEditableView(collectionSlug: string, viewRef: ViewRef, userId: string) {
  const access = await findAccessibleCollection(collectionSlug, userId, "editor");
  if (!access) return null;

  const [view] = await db
    .select()
    .from(views)
    .where(viewRefCondition(access.collection.id, viewRef))
    .limit(1);
  return view ? { view, slug: access.collection.slug, collection: access.collection } : null;
}

export async function renameView(collectionSlug: string, viewId: number, userId: string, name: string) {
  const validated = validateTrimmedLength(name, MAX_VIEW_NAME_LENGTH, "Name");
  if ("error" in validated) return validated;

  const existing = await findEditableView(collectionSlug, viewId, userId);
  if (!existing) return { error: "View not found", status: 404 };

  const [updated] = await db
    .update(views)
    .set({ name: validated.value, updatedAt: new Date() })
    .where(eq(views.id, existing.view.id))
    .returning();

  revalidateDashboard(existing.slug, "views");
  return { view: updated };
}

// Allowlist of view-config keys clients may set. Anything else is dropped at
// the service boundary so a malicious client can't poison the config blob with
// keys that downstream renderers might trust.
const ALLOWED_CONFIG_KEYS = ["groupField", "dateField", "cardTitle", "imageField", "groupByField"] as const;
type AllowedConfigKey = (typeof ALLOWED_CONFIG_KEYS)[number];

function pickAllowedConfig(config: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ALLOWED_CONFIG_KEYS as readonly AllowedConfigKey[]) {
    if (key in config) {
      const value = config[key];
      if (value === null || (typeof value === "string" && value.length <= 200)) {
        picked[key] = value;
      }
    }
  }
  return picked;
}

export async function updateViewConfig(
  collectionSlug: string,
  viewId: number,
  userId: string,
  config: Record<string, unknown>
) {
  const existing = await findEditableView(collectionSlug, viewId, userId);
  if (!existing) return null;

  const sanitized = pickAllowedConfig(config);
  const merged = { ...((existing.view.config as Record<string, unknown>) ?? {}), ...sanitized };
  const set: Partial<typeof views.$inferInsert> = { config: merged };
  // A published view keeps the field its new layout needs.
  if (existing.view.published) {
    const columns = storedColumns(existing.view.columns);
    const withLayout = withLayoutField(columns, existing.view.type, merged, publishableFields(existing.collection.schema));
    if (withLayout !== columns) set.columns = withLayout;
  }
  const [updated] = await db
    .update(views)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(views.id, existing.view.id))
    .returning();

  revalidateDashboard(existing.slug, "views");
  return { view: updated };
}

/**
 * Seed sensible default views for a freshly-created collection based on the
 * shape of its inferred schema. Best-effort: a failure to create one view
 * doesn't block the others, and the helper never throws.
 *
 * - Calendar view: when a `date`-typed field exists whose name isn't a
 *   timestamp column. The first matching field becomes `config.dateField`.
 * - Kanban view: when a `select`/`multiselect` field exists. The first
 *   matching field becomes `config.groupByField`.
 * - Gallery view: when an `image_url`-typed field exists. The first matching
 *   field becomes `config.imageField`; if a `text` field also exists, the
 *   first one becomes `config.cardTitle`.
 * - Timeline view: when a non-timestamp `date`-typed field exists. The first
 *   matching field becomes `config.dateField`; if a `text` field also exists,
 *   the first one becomes `config.cardTitle`.
 */
export async function seedAutoViews(
  collectionSlug: string,
  userId: string,
  schema: CollectionSchema,
): Promise<void> {
  const fields = schema?.fields ?? [];
  if (fields.length === 0) return;

  const dateField = fields.find((f) => f.type === "date" && !TIMESTAMP_FIELD_NAMES.has(f.name));
  const selectField = fields.find(isSelectableField);
  const imageField = fields.find((f) => f.type === "image_url");
  const textField = fields.find((f) => f.type === "text");

  const seeds: { type: "calendar" | "kanban" | "gallery" | "timeline"; config: Record<string, unknown> }[] = [];
  if (dateField) {
    seeds.push({ type: "calendar", config: { dateField: dateField.name } });
    const timelineConfig: Record<string, unknown> = { dateField: dateField.name };
    if (textField) timelineConfig.cardTitle = textField.name;
    seeds.push({ type: "timeline", config: timelineConfig });
  }
  if (selectField) seeds.push({ type: "kanban", config: { groupByField: selectField.name } });
  if (imageField) {
    const galleryConfig: Record<string, unknown> = { imageField: imageField.name };
    if (textField) galleryConfig.cardTitle = textField.name;
    seeds.push({ type: "gallery", config: galleryConfig });
  }

  const results = await Promise.allSettled(
    seeds.map((seed) => createView(collectionSlug, userId, { type: seed.type, config: seed.config })),
  );
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`seedAutoViews: failed to seed ${seeds[i].type} view`, result.reason);
    }
  });
}

export async function updateView(
  collectionSlug: string,
  viewRef: ViewRef,
  userId: string,
  patch: {
    name?: string;
    columns?: string[];
    sort?: string | null;
    filter?: Record<string, unknown>;
    config?: Record<string, unknown>;
    groupBy?: string;
    published?: boolean;
  },
) {
  let name: string | undefined;
  if (patch.name !== undefined) {
    const validated = validateTrimmedLength(patch.name, MAX_VIEW_NAME_LENGTH, "Name");
    if ("error" in validated) return validated;
    name = validated.value;
  }

  const found = await findEditableView(collectionSlug, viewRef, userId);
  if (!found) return null;
  const { view, slug, collection } = found;

  // Grouping set through config takes the same path as groupBy, so it gets
  // the kanban check and replaces a stale dashboard groupField.
  const config = pickAllowedConfig(patch.config ?? {});
  const groupBy = patch.groupBy ?? config.groupByField ?? config.groupField;
  delete config.groupByField;
  delete config.groupField;
  if (groupBy !== undefined && view.type !== "kanban") return GROUP_BY_KANBAN_ONLY;

  const set: Partial<typeof views.$inferInsert> = {};
  if (name !== undefined) set.name = name;
  if (patch.columns !== undefined) set.columns = patch.columns;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.filter !== undefined) set.filter = patch.filter;
  if (patch.published !== undefined) set.published = patch.published;
  if (Object.keys(config).length > 0 || groupBy !== undefined) {
    const merged: Record<string, unknown> = { ...((view.config as Record<string, unknown>) ?? {}), ...config };
    if (groupBy !== undefined) {
      merged.groupByField = groupBy;
      // The dashboard writes groupField and readers prefer it; a stale one
      // would hide the new grouping.
      delete merged.groupField;
    }
    set.config = merged;
  }
  // Publishing, or changing the columns of a view that stays published,
  // needs publishable columns; a published view also keeps its layout field.
  const columnsChecked = patch.published === true || (patch.columns !== undefined && view.published && patch.published !== false);
  if (columnsChecked || (view.published && patch.published !== false && set.config !== undefined)) {
    const publishable = publishableFields(collection.schema);
    const columns = patch.columns ?? storedColumns(view.columns);
    if (columnsChecked) {
      const invalid = unpublishableColumns(columns, publishable);
      if (invalid) return invalid;
    }
    const withLayout = withLayoutField(columns, view.type, set.config ?? view.config, publishable);
    if (withLayout !== columns) set.columns = withLayout;
  }
  if (Object.keys(set).length === 0) return { view, slug };

  const [updated] = await db.update(views).set({ ...set, updatedAt: new Date() }).where(eq(views.id, view.id)).returning();

  revalidateDashboard(slug, "views");
  return { view: updated, slug };
}

export async function deleteView(collectionSlug: string, viewRef: ViewRef, userId: string) {
  const access = await findAccessibleCollection(collectionSlug, userId, "editor");
  if (!access) return null;

  const [deleted] = await db
    .delete(views)
    .where(viewRefCondition(access.collection.id, viewRef))
    .returning({ id: views.id });
  if (!deleted) return null;

  revalidateDashboard(access.collection.slug, "views");
  return { deleted: true };
}

/** The collection's views, oldest first, as hutch_get_collection lists them. */
export async function listViews(collectionSlug: string, userId: string) {
  const access = await findAccessibleCollection(collectionSlug, userId, "viewer");
  if (!access) return null;

  return db
    .select({
      id: views.id, name: views.name, slug: views.slug, type: views.type, published: views.published,
      columns: views.columns, sort: views.sort, filter: views.filter, config: views.config,
    })
    .from(views)
    .where(eq(views.collectionId, access.collection.id))
    .orderBy(asc(views.id));
}
