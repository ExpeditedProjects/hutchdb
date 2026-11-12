import { db } from "@/lib/db";
import { views } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import type { CollectionAccess } from "@/lib/db/queries";
import { findAccessibleCollection } from "./resolve";
import { uniqueSlug, titleCase } from "@/lib/slugify";
import { revalidateDashboard } from "@/lib/revalidation";
import { MAX_VIEW_NAME_LENGTH } from "@/lib/views/types";
import { layoutField, publishableFields } from "@/lib/views/layout-fields";
import { validateTrimmedLength } from "@/lib/validation";
import type { CollectionSchema } from "@/lib/schema-inference";
import { isSelectableField } from "@/lib/schema/field-types";

const TIMESTAMP_FIELD_NAMES = new Set(["created_at", "updated_at"]);

/**
 * A service error. Messages are written for any client (the Cloud dashboard
 * shows them as they are); `code` lets the MCP tools add their own hints.
 */
type ViewError = { error: string; status: number; code?: string };

const GROUP_BY_KANBAN_ONLY: ViewError = { error: "group_by applies to kanban views only", status: 400 };

const NO_GROUP_FIELD: ViewError = {
  error: "Cannot infer a field to group by: the collection has no visible select field.",
  status: 400,
  code: "no_group_field",
};

// ── Publishing ────────────────────────────────────────────────────────────────
//
// A published view is a public read-only page showing the collection's and
// the view's names and descriptions, the view's columns, and the records its
// filter matches. Only the collection's owner may publish a view or change a
// published one (anyone who can edit may unpublish it). Its columns must be
// distinct visible fields of the saved schema and include the field its
// layout uses, so nothing is public that the owner didn't pick. This is the
// one place these rules are enforced: the MCP tools and the Cloud dashboard
// both go through createView, updateView, updateViewConfig and renameView.

export const MAX_PUBLISHED_COLUMNS = 500;
/** Most names an error lists, and the longest name it echoes. */
const MAX_LISTED_NAMES = 50;
const MAX_ECHOED_NAME_LENGTH = 100;

const OWNER_ONLY: ViewError = {
  error: "Only the collection's owner can publish a view or change a published one.",
  status: 403,
  code: "owner_only",
};

/** How each layout uses its field, for error messages. */
const LAYOUT_USE: Record<string, string> = {
  kanban: "groups by",
  calendar: "places records by the date in",
  timeline: "places records by the date in",
  gallery: "shows the images in",
};

function echo(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > MAX_ECHOED_NAME_LENGTH ? `${text.slice(0, MAX_ECHOED_NAME_LENGTH)}…` : text;
}

function listNames(values: unknown[]): string {
  const listed = values.slice(0, MAX_LISTED_NAMES).map(echo).join(", ");
  const rest = values.length - MAX_LISTED_NAMES;
  return rest > 0 ? `${listed}, and ${rest} more` : listed;
}

/**
 * The columns to store for a view that is, or stays, published, or why it
 * cannot be published. `columns` is the raw stored or requested value, so
 * anything that is not a list of distinct visible field names is refused.
 */
function publishedColumns(columns: unknown, type: string | null, config: unknown, schema: unknown): { columns: string[] } | ViewError {
  const publishable = publishableFields(schema);
  if (publishable.length === 0) {
    return {
      error: "This collection has no saved schema fields yet (or all of them are hidden), so its views cannot be published. Save its schema or unhide a field, then pick the columns.",
      status: 400,
      code: "no_publishable_fields",
    };
  }
  const valid = `Valid fields: ${listNames(publishable)}.`;
  if (!Array.isArray(columns) || columns.length === 0) {
    return { error: `Set columns before publishing: a published view shows only the fields listed in its columns. ${valid}`, status: 400, code: "invalid_columns" };
  }
  if (columns.length > MAX_PUBLISHED_COLUMNS) {
    return { error: `A published view can have at most ${MAX_PUBLISHED_COLUMNS} columns; this one has ${columns.length}.`, status: 400 };
  }
  // `allowed` holds only strings, so a non-string entry is invalid too.
  const allowed: Set<unknown> = new Set(publishable);
  const invalid = columns.filter((c) => !allowed.has(c));
  if (invalid.length > 0) {
    return {
      error: `These columns are hidden or not in the collection's saved schema, so they cannot be published: ${listNames(invalid)}. ${valid}`,
      status: 400,
      code: "invalid_columns",
    };
  }
  const names = columns as string[];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of names) (seen.has(name) ? repeated : seen).add(name);
  if (repeated.size > 0) {
    return { error: `These columns are listed more than once: ${listNames([...repeated])}. List each field once.`, status: 400 };
  }
  const field = layoutField(type, config);
  if (field !== undefined) {
    const uses = `This ${type} view ${LAYOUT_USE[type ?? ""] ?? "uses"} "${echo(field)}"`;
    if (!allowed.has(field)) {
      return { error: `${uses}, which is hidden or not in the collection's saved schema, so the view cannot be published.`, status: 400, code: "invalid_columns" };
    }
    if (!seen.has(field)) {
      return { error: `${uses}, so "${echo(field)}" must be one of its columns before it can be published.`, status: 400 };
    }
  }
  return { columns: names };
}

/** The first visible select field: the MCP tool's default kanban grouping. */
function firstVisibleSelectField(schema: unknown): string | undefined {
  const fields = (schema as { fields?: { name?: unknown; type?: unknown; hidden?: unknown }[] } | null)?.fields;
  if (!Array.isArray(fields)) return undefined;
  const field = fields.find((f) => f?.type === "select" && !f.hidden && typeof f.name === "string");
  return field?.name as string | undefined;
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
  /** A kanban given no group field groups by the first visible select field, or fails without one. */
  inferGroupBy?: boolean;
  published?: boolean;
}): Promise<{ view: typeof views.$inferSelect; slug: string } | ViewError | null> {
  let resolvedName: string | undefined;
  if (params.name !== undefined) {
    const validated = validateTrimmedLength(params.name, MAX_VIEW_NAME_LENGTH, "Name");
    if ("error" in validated) return validated;
    resolvedName = validated.value;
  }

  const access = await findAccessibleCollection(collectionSlug, userId, "editor");
  if (!access) return null;
  if (params.published && access.role !== "owner") return OWNER_ONLY;
  // The argument may be the collection's name; continue with its slug.
  collectionSlug = access.collection.slug;

  const type = params.type || "table";
  if (params.groupBy && type !== "kanban") return GROUP_BY_KANBAN_ONLY;
  const name = resolvedName ?? titleCase(type);

  const config = pickAllowedConfig(params.config ?? {});
  let groupBy = params.groupBy;
  if (!groupBy && params.inferGroupBy && type === "kanban" && !config.groupField && !config.groupByField) {
    groupBy = firstVisibleSelectField(access.collection.schema);
    if (!groupBy) return NO_GROUP_FIELD;
  }
  if (groupBy) {
    config.groupByField = groupBy;
    // Readers prefer the dashboard's groupField; a stale one would hide this grouping.
    delete config.groupField;
  }

  let columns = params.columns ?? [];
  if (params.published) {
    const checked = publishedColumns(columns, type, config, access.collection.schema);
    if ("error" in checked) return checked;
    columns = checked.columns;
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

type ViewRow = typeof views.$inferSelect;
type ViewChange = Partial<typeof views.$inferInsert>;

function viewRefCondition(collectionId: number, viewRef: ViewRef) {
  return and(
    typeof viewRef === "number" ? eq(views.id, viewRef) : eq(views.slug, viewRef),
    eq(views.collectionId, collectionId),
  );
}

/**
 * Reads the view, lets `plan` decide the change from it, and writes that, in
 * one transaction holding the view's row lock, so a concurrent publish and
 * column change can't both pass their checks against the old row. Same
 * access rule as createView (editor); `plan` applies the owner rule. Null
 * when the collection or view isn't found; an empty change writes nothing.
 */
async function changeView(
  collectionSlug: string,
  viewRef: ViewRef,
  userId: string,
  plan: (view: ViewRow, access: CollectionAccess) => ViewChange | ViewError,
): Promise<{ view: ViewRow; slug: string } | ViewError | null> {
  const access = await findAccessibleCollection(collectionSlug, userId, "editor");
  if (!access) return null;

  const result = await db.transaction(async (tx) => {
    const [view] = await tx.select().from(views).where(viewRefCondition(access.collection.id, viewRef)).limit(1).for("update");
    if (!view) return null;
    const change = plan(view, access);
    if ("error" in change) return change;
    if (Object.keys(change).length === 0) return { view, written: false };
    const [updated] = await tx.update(views).set({ ...change, updatedAt: new Date() }).where(eq(views.id, view.id)).returning();
    return { view: updated, written: true };
  });
  if (!result || "error" in result) return result;
  if (result.written) revalidateDashboard(access.collection.slug, "views");
  return { view: result.view, slug: access.collection.slug };
}

/** A published view is the owner's to change (unpublishing aside, which updateView allows anyone who can edit). */
function publishedAndNotOwner(view: ViewRow, access: CollectionAccess): boolean {
  return view.published && access.role !== "owner";
}

export async function renameView(collectionSlug: string, viewId: number, userId: string, name: string) {
  const validated = validateTrimmedLength(name, MAX_VIEW_NAME_LENGTH, "Name");
  if ("error" in validated) return validated;

  const result = await changeView(collectionSlug, viewId, userId, (view, access) =>
    publishedAndNotOwner(view, access) ? OWNER_ONLY : { name: validated.value });
  if (!result) return { error: "View not found", status: 404 };
  if ("error" in result) return result;
  return { view: result.view };
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
  const result = await changeView(collectionSlug, viewId, userId, (view, access) => {
    if (publishedAndNotOwner(view, access)) return OWNER_ONLY;
    const merged = { ...((view.config as Record<string, unknown>) ?? {}), ...pickAllowedConfig(config) };
    if (!view.published) return { config: merged };
    // A published view's new layout field must already be one of its columns.
    const checked = publishedColumns(view.columns, view.type, merged, access.collection.schema);
    return "error" in checked ? checked : { config: merged, columns: checked.columns };
  });
  if (!result || "error" in result) return result;
  return { view: result.view };
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

  return changeView(collectionSlug, viewRef, userId, (view, access) => {
    // Publishing, and changing a view that stays published, are the owner's;
    // anyone who can edit may unpublish (the view is then private).
    const staysPublished = patch.published ?? view.published;
    const changesMore = Object.entries(patch).some(([key, value]) => key !== "published" && value !== undefined);
    if (access.role !== "owner" && staysPublished && (patch.published === true || changesMore)) return OWNER_ONLY;

    // Grouping set through config takes the same path as groupBy, so it gets
    // the kanban check and replaces a stale dashboard groupField.
    const config = pickAllowedConfig(patch.config ?? {});
    const groupBy = patch.groupBy ?? config.groupByField ?? config.groupField;
    delete config.groupByField;
    delete config.groupField;
    if (groupBy !== undefined && view.type !== "kanban") return GROUP_BY_KANBAN_ONLY;

    const set: ViewChange = {};
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
    // Publishing, or changing the columns or layout of a view that stays
    // published, needs columns that pass publishedColumns.
    if (staysPublished && (patch.published === true || set.columns !== undefined || set.config !== undefined)) {
      const checked = publishedColumns(set.columns ?? view.columns, view.type, set.config ?? view.config, access.collection.schema);
      if ("error" in checked) return checked;
      set.columns = checked.columns;
    }
    return set;
  });
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
