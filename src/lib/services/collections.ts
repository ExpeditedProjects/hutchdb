import { db } from "@/lib/db";
import { collections, collectionMembers, organizations, user, type CollectionRole } from "@/lib/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { eq, and, sql, desc } from "drizzle-orm";
import { createCollectionWithOwner } from "@/lib/db/queries";
import { findAccessibleCollection } from "./resolve";
import { DESCRIBE_FIELDS_PAGE, describeFields, type DescribePage } from "@/lib/describe";
import { uniqueSlug } from "@/lib/slugify";
import { revalidateDashboard } from "@/lib/revalidation";
import { inferSchema, mergeSchema, CollectionSchema, FieldDefinition, isSelectableField, MAX_OPTION_VALUE_LENGTH, MAX_OPTIONS_PER_FIELD } from "@/lib/schema-inference";
import { DEFAULT_RECORD_STATUS, FIELD_NAME_RE, MAX_FIELD_NAME_LENGTH } from "@/lib/constants";
import { validateTrimmedLength } from "@/lib/validation";
import { seedAutoViews } from "./views";
import { queryIndexes, readRegistry } from "@/lib/storage/registry";
import { dropCollectionTable } from "@/lib/storage/ddl";
import * as tableRows from "@/lib/storage/rows";
import { COLLECTION_QUERY_CONCURRENCY, mapLimit } from "@/lib/map-limit";

export type RecentCollection = { name: string; slug: string; role: CollectionRole };

export type CrossOrgRecentCollection = {
  id: number;
  name: string;
  slug: string;
  role: CollectionRole;
  recordCount: number;
  lastRecordAt: string | null;
  updatedAt: Date | null;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  organizationPersonal: boolean;
};

/**
 * Most-recently-updated collections the user can access, regardless of
 * which org they belong to. Powers the dashboard's "recent" widget,
 * which is a cross-org overview (the org-scoped list lives in the
 * sidebar). Annotates each row with its org so the table can render an
 * Organization column.
 *
 * Record counts come from each collection's own table in one extra round
 * trip (see recordCounts).
 */
export async function listRecentCollectionsAcrossOrgs(
  userId: string,
  limit: number,
): Promise<CrossOrgRecentCollection[]> {
  if (!userId) return [];

  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      slug: collections.slug,
      role: collectionMembers.role,
      updatedAt: collections.updatedAt,
      organizationId: organizations.id,
      organizationSlug: organizations.slug,
      organizationName: organizations.name,
      organizationPersonal: organizations.personal,
    })
    .from(collections)
    .innerJoin(
      collectionMembers,
      and(eq(collectionMembers.collectionId, collections.id), eq(collectionMembers.userId, userId)),
    )
    .innerJoin(organizations, eq(organizations.id, collections.organizationId))
    .orderBy(desc(collections.updatedAt))
    .limit(limit);

  const counts = await tableRows.recordCounts(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, role: r.role as CollectionRole, ...countFields(counts.get(r.id)) }));
}

/** recordCount / lastRecordAt (ISO) for a listing row. */
function countFields(entry: { count: number; lastAt: Date | null } | undefined): { recordCount: number; lastRecordAt: string | null } {
  return { recordCount: entry?.count ?? 0, lastRecordAt: entry?.lastAt ? entry.lastAt.toISOString() : null };
}

export type DashboardCollectionRow = {
  id: number;
  name: string;
  slug: string;
  recordCount: number;
  viewCount: number;
  role: CollectionRole;
  ownerName: string | null;
  ownerEmail: string | null;
  updatedAt: Date | null;
  lastRecordAt: string | null;
};

/**
 * Dashboard-grade collection list with record/view counts and owner —
 * scoped to one org. The sidebar and dashboard page both use this; org
 * isolation is the model, so there is no cross-org "guest" variant.
 */
export async function listCollectionsForDashboard(
  userId: string,
  organizationId: string,
): Promise<DashboardCollectionRow[]> {
  if (!userId) return [];
  const callerMember = alias(collectionMembers, "caller_member");
  const ownerMember = alias(collectionMembers, "owner_member");

  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      slug: collections.slug,
      viewCount: sql<number>`(SELECT count(*)::int + 1 FROM views v WHERE v.collection_id = "collections"."id")`,
      role: sql<CollectionRole>`${callerMember.role}`,
      ownerName: user.name,
      ownerEmail: user.email,
      updatedAt: collections.updatedAt,
    })
    .from(collections)
    .innerJoin(
      callerMember,
      and(eq(callerMember.collectionId, collections.id), eq(callerMember.userId, userId))
    )
    .leftJoin(
      ownerMember,
      and(eq(ownerMember.collectionId, collections.id), eq(ownerMember.role, "owner"))
    )
    .leftJoin(user, eq(user.id, ownerMember.userId))
    .where(eq(collections.organizationId, organizationId))
    .orderBy(desc(collections.updatedAt));

  const counts = await tableRows.recordCounts(rows.map((r) => r.id));
  return rows.map(({ viewCount, ...r }) => ({ ...r, viewCount, ...countFields(counts.get(r.id)) }));
}

export async function listRecentCollectionsForUser(
  userId: string,
  organizationId: string | null,
  limit: number,
): Promise<RecentCollection[]> {
  if (!userId) return [];

  const conditions = [eq(collectionMembers.userId, userId)];
  if (organizationId) conditions.push(eq(collections.organizationId, organizationId));

  const rows = await db
    .select({
      name: collections.name,
      slug: collections.slug,
      role: collectionMembers.role,
      updatedAt: collections.updatedAt,
    })
    .from(collections)
    .innerJoin(
      collectionMembers,
      and(eq(collectionMembers.collectionId, collections.id), eq(collectionMembers.userId, userId))
    )
    .where(and(...conditions))
    .orderBy(desc(collections.updatedAt))
    .limit(limit);

  return rows.map((r) => ({ name: r.name, slug: r.slug, role: r.role as CollectionRole }));
}

export async function listCollections(userId: string, organizationId?: string) {
  if (!userId) return [];

  const conditions = [eq(collectionMembers.userId, userId)];
  if (organizationId) conditions.push(eq(collections.organizationId, organizationId));

  const colls = await db
    .select({
      id: collections.id,
      name: collections.name,
      slug: collections.slug,
      description: collections.description,
      schema: collections.schema,
      uniqueKey: collections.uniqueKey,
      published: collections.published,
      createdAt: collections.createdAt,
      updatedAt: collections.updatedAt,
      role: collectionMembers.role,
    })
    .from(collections)
    .innerJoin(
      collectionMembers,
      and(eq(collectionMembers.collectionId, collections.id), eq(collectionMembers.userId, userId))
    )
    .where(and(...conditions))
    .orderBy(desc(collections.updatedAt));

  if (colls.length === 0) return [];

  const counts = await tableRows.recordCounts(colls.map((c) => c.id));
  return mapLimit(colls, COLLECTION_QUERY_CONCURRENCY, async (coll) => {
    const fields = await tableRows.sampleFieldNames(coll.id, 10);
    return { ...coll, ...countFields(counts.get(coll.id)), fields: fields.sort() };
  });
}

export async function createCollection(userId: string, organizationId: string, params: {
  name: string;
  description?: string;
  schema?: unknown;
  unique_key?: unknown;
  published?: boolean;
}) {
  const { name, description, schema: schemaVal, unique_key, published } = params;

  const slug = uniqueSlug(name);

  const created = await createCollectionWithOwner({
    organizationId,
    ownerUserId: userId,
    name,
    slug,
    description: description || null,
    schema: schemaVal ?? { fields: [] },
    uniqueKey: unique_key ?? [],
    published: published ?? false,
  });

  if (schemaVal && (schemaVal as CollectionSchema)?.fields?.length) {
    await seedAutoViews(slug, userId, schemaVal as CollectionSchema);
  }

  revalidateDashboard(slug);
  return { collection: created };
}

/**
 * One collection with its record count. With `page` (the MCP tool always
 * passes one), schema.fields is cut to one page in schema order — a wide
 * collection's saved schema can list thousands of fields — with the same
 * paging metadata as describe; without it, the whole schema.
 */
export async function getCollection(slug: string, userId: string, page?: FieldPage) {
  const access = await findAccessibleCollection(slug, userId, "viewer");
  if (!access) return null;
  const collection = access.collection;

  const [recordCount, lastAt] = await Promise.all([
    tableRows.countRecords(collection.id),
    tableRows.lastRecordAt(collection.id),
  ]);
  const result = { ...collection, role: access.role, recordCount, lastRecordAt: lastAt ? lastAt.toISOString() : null };
  const schema = collection.schema as CollectionSchema | null;
  if (!page || !schema || !Array.isArray(schema.fields)) return result;
  const offset = Math.max(0, Math.floor(page.fields_offset ?? 0));
  const matching = page.field_prefix ? schema.fields.filter((f) => f.name.startsWith(page.field_prefix!)) : schema.fields;
  const fields = matching.slice(offset, offset + DESCRIBE_FIELDS_PAGE);
  return {
    ...result,
    schema: { ...schema, fields },
    ...fieldPageInfo(page, matching.length, schema.fields.length, fields.length, offset, "schema.fields, in schema order"),
  };
}

export async function updateCollection(slug: string, userId: string, updates: Record<string, unknown>) {
  const access = await findAccessibleCollection(slug, userId, "owner");
  if (!access) return { error: "Collection not found", status: 404 };
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collection = access.collection;

  const dbUpdates: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.description !== undefined) dbUpdates.description = updates.description;
  if (updates.schema !== undefined) dbUpdates.schema = updates.schema;
  if (updates.unique_key !== undefined) dbUpdates.uniqueKey = updates.unique_key;
  if (updates.published !== undefined) {
    dbUpdates.published = updates.published;
    if (updates.published && !collection.publishedAt) {
      dbUpdates.publishedAt = new Date();
    }
  }

  const [updated] = await db
    .update(collections)
    .set(dbUpdates)
    .where(eq(collections.id, collection.id))
    .returning();

  revalidateDashboard(slug);
  return { collection: updated };
}

export async function deleteCollection(slug: string, userId: string) {
  const access = await findAccessibleCollection(slug, userId, "owner");
  if (!access) return { error: "Collection not found", status: 404 };
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;

  await db.transaction(async (tx) => {
    await dropCollectionTable(tx, access.collection.id);
    await tx.delete(collections).where(eq(collections.id, access.collection.id));
  });
  revalidateDashboard(slug);
  return { deleted: true, slug };
}

export async function inferCollectionSchema(slug: string, userId: string) {
  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collection = access.collection;

  const inferred = await inferSchema(collection.id);
  const existingSchema = collection.schema as CollectionSchema | null;
  const merged = mergeSchema(existingSchema, inferred);

  await db.update(collections).set({ schema: merged, updatedAt: new Date() }).where(eq(collections.id, collection.id));
  revalidateDashboard(slug, "schema");

  return { schema: merged, slug };
}

export async function updateFieldDefinition(
  slug: string,
  userId: string,
  fieldName: string,
  updates: Partial<Pick<FieldDefinition, "type" | "options" | "position" | "hidden">>
) {
  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collection = access.collection;

  const schema = (collection.schema as CollectionSchema) || { fields: [], version: 0, lastInferredAt: "" };
  const fieldIndex = schema.fields.findIndex((f) => f.name === fieldName);

  if (fieldIndex === -1) {
    return { error: "Field not found in schema", status: 404 };
  }

  const field = schema.fields[fieldIndex];
  schema.fields[fieldIndex] = {
    ...field,
    ...updates,
    inferred: false,
  };
  schema.version = (schema.version || 0) + 1;

  await db.update(collections).set({ schema, updatedAt: new Date() }).where(eq(collections.id, collection.id));
  revalidateDashboard(slug, "schema");

  return { field: schema.fields[fieldIndex], slug };
}

export async function addFieldDefinition(
  slug: string,
  userId: string,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed || !FIELD_NAME_RE.test(trimmed)) {
    return { error: "Field name must contain only letters, numbers, and underscores", status: 400 };
  }
  if (trimmed.length > MAX_FIELD_NAME_LENGTH) {
    return { error: `Field name must be ${MAX_FIELD_NAME_LENGTH} characters or fewer`, status: 400 };
  }

  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collectionId = access.collection.id;

  // Lock the row so concurrent addFieldDefinition / addFieldOption calls can't
  // overwrite each other's schema mutations.
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ schema: collections.schema })
        .from(collections)
        .where(eq(collections.id, collectionId))
        .for("update");

      const schema = (row?.schema as CollectionSchema) || { fields: [], version: 0, lastInferredAt: "" };
      if (schema.fields.some((f) => f.name === trimmed)) {
        return { error: "Field already exists", status: 409 } as const;
      }

      const maxPosition = schema.fields.reduce((m, f) => Math.max(m, f.position ?? 0), -1);
      const newField: FieldDefinition = {
        name: trimmed,
        type: "select",
        options: [],
        inferred: false,
        hidden: false,
        position: maxPosition + 1,
      };

      const updated: CollectionSchema = {
        ...schema,
        fields: [...schema.fields, newField],
        version: (schema.version || 0) + 1,
      };

      await tx.update(collections).set({ schema: updated, updatedAt: new Date() }).where(eq(collections.id, collectionId));
      revalidateDashboard(slug, "schema");
      return { field: newField } as const;
    });
  } catch (err) {
    console.error("addFieldDefinition transaction failed", err);
    return { error: "Failed to add field", status: 500 };
  }
}

export async function addFieldOption(
  slug: string,
  userId: string,
  fieldName: string,
  value: string,
) {
  const validated = validateTrimmedLength(value, MAX_OPTION_VALUE_LENGTH, "Option value");
  if ("error" in validated) return validated;
  const trimmed = validated.value;

  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collectionId = access.collection.id;

  // Fast path: skip the row lock when the cached snapshot already contains the
  // value. Clicking an existing column header is the most common case.
  const cachedField = (access.collection.schema as CollectionSchema | null)?.fields.find((f) => f.name === fieldName);
  if (cachedField && isSelectableField(cachedField) && cachedField.options?.includes(trimmed)) {
    return { field: cachedField };
  }

  // Otherwise serialize concurrent appends on the row via SELECT ... FOR UPDATE
  // so two clients adding different options can't lose each other.
  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ schema: collections.schema })
        .from(collections)
        .where(eq(collections.id, collectionId))
        .for("update");

      const schema = (row?.schema as CollectionSchema) || { fields: [], version: 0, lastInferredAt: "" };
      const fieldIndex = schema.fields.findIndex((f) => f.name === fieldName);
      if (fieldIndex === -1) {
        return { error: "Field not found in schema", status: 404 } as const;
      }

      const field = schema.fields[fieldIndex];
      if (!isSelectableField(field)) {
        return { error: `Field is type ${field.type}; can only add options to select or multiselect fields`, status: 400 } as const;
      }

      const existing = field.options ?? [];
      if (existing.includes(trimmed)) {
        return { field } as const;
      }
      if (existing.length >= MAX_OPTIONS_PER_FIELD) {
        return { error: `Field already has the maximum ${MAX_OPTIONS_PER_FIELD} options`, status: 400 } as const;
      }

      const updated: FieldDefinition = {
        ...field,
        options: [...existing, trimmed],
        inferred: false,
      };
      schema.fields[fieldIndex] = updated;
      schema.version = (schema.version || 0) + 1;

      await tx.update(collections).set({ schema, updatedAt: new Date() }).where(eq(collections.id, collectionId));
      return { field: updated } as const;
    });

    if ("field" in result) revalidateDashboard(slug, "schema");
    return result;
  } catch (err) {
    console.error("addFieldOption transaction failed", err);
    return { error: "Failed to add option, please retry", status: 500 } as const;
  }
}

/** Cap on how many distinct top-level keys the fill-rate report returns. */
const STATS_MAX_FIELDS = 50;

/**
 * Collection statistics: record count, counts by status, first/last
 * created/updated timestamps, approximate storage bytes, and per-field
 * fill rates for top-level keys (most common first, capped at 50).
 */
export async function getCollectionStats(slug: string, userId: string) {
  const access = await findAccessibleCollection(slug, userId, "viewer");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collection = access.collection;

  const [summaryResult, statusResult, fieldResult] = await tableRows.collectionStats(collection.id, STATS_MAX_FIELDS);

  const summary = (summaryResult.rows[0] ?? {}) as {
    record_count?: number;
    first_created_at?: string | null;
    last_created_at?: string | null;
    first_updated_at?: string | null;
    last_updated_at?: string | null;
    approx_storage_bytes?: string | number | null;
  };
  const recordCount = summary.record_count ?? 0;

  const byStatus: Record<string, number> = {};
  for (const row of statusResult.rows as { status: string | null; count: number }[]) {
    byStatus[row.status ?? DEFAULT_RECORD_STATUS] = row.count;
  }

  const fields = (fieldResult.rows as { key: string; count: number }[]).map((row) => ({
    name: row.key,
    count: row.count,
    percent: recordCount > 0 ? Math.round((row.count / recordCount) * 1000) / 10 : 0,
  }));

  return {
    name: collection.name,
    slug: collection.slug,
    record_count: recordCount,
    by_status: byStatus,
    first_created_at: summary.first_created_at ?? null,
    last_created_at: summary.last_created_at ?? null,
    first_updated_at: summary.first_updated_at ?? null,
    last_updated_at: summary.last_updated_at ?? null,
    approx_storage_bytes: Number(summary.approx_storage_bytes ?? 0),
    fields,
  };
}

export type FieldPage = { fields_offset?: number; field_prefix?: string };

/**
 * Paging metadata for a bounded field list: how many fields exist, how
 * many this call returned, and how to get the rest.
 */
function fieldPageInfo(page: FieldPage, matched: number, total: number, returned: number, offset: number, source: string) {
  const omitted = Math.max(0, matched - offset - returned);
  const nextOffset = omitted > 0 ? offset + returned : null;
  const info: Record<string, unknown> = {
    fields_total: total,
    ...(page.field_prefix ? { fields_matching_prefix: matched } : {}),
    fields_offset: offset,
    fields_returned: returned,
    fields_omitted: Math.max(0, matched - returned),
    fields_next_offset: nextOffset,
  };
  if (nextOffset !== null) {
    const which = page.field_prefix ? ` starting with '${page.field_prefix}'` : "";
    info.fields_hint = `Fields ${offset + 1}–${offset + returned} of ${matched}${which} (${source}). Pass fields_offset: ${nextOffset} for the next ${DESCRIBE_FIELDS_PAGE}, or field_prefix (the start of a field name) to find specific fields.`;
  }
  return info;
}

export async function describeCollection(slug: string, userId: string, page: FieldPage = {}) {
  const access = await findAccessibleCollection(slug, userId, "viewer");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collection = access.collection;

  const recordCount = await tableRows.countRecords(collection.id);
  const describePage: DescribePage = { offset: page.fields_offset, prefix: page.field_prefix };
  const described = await describeFields(collection.id, recordCount, collection.storage, describePage);

  return {
    name: collection.name,
    slug: collection.slug,
    description: collection.description,
    recordCount,
    uniqueKey: collection.uniqueKey,
    fields: described.fields,
    ...fieldPageInfo(page, described.matched, described.total, described.fields.length, described.offset, "most common first, from a sample of up to 500 records; hutch_collection_stats has exact fill rates"),
    storage: await describeStorage(collection),
  };
}

/**
 * What inference has created for a collection: projected fields and
 * unwound arrays with their reasons and child row counts.
 */
async function describeStorage(collection: { id: number; storage: unknown }) {
  const registry = readRegistry(collection.storage);
  const counts = await tableRows.childTableCounts(registry.unwinds.map((u) => u.table));
  return {
    evaluated_rows: registry.evaluated_rows,
    projections: registry.projections.map((p) => p.mixed
      // The stored reason describes the data when the column was made;
      // since then some record held another type there.
      ? { field: p.field, type: p.type, mixed: true, reason: `Projected as ${p.type} when '${p.field}' held only ${p.type} values; some records now hold other types there (mixed), so this column serves equality, $in and $ne, while ranges and sort read the documents.` }
      : { field: p.field, type: p.type, reason: p.reason }),
    unwinds: registry.unwinds.map((u) => ({
      path: u.path,
      fields: u.fields.map((f) => ({ field: f.field, type: f.type })),
      rows: counts[u.table] ?? 0,
      reason: u.reason,
    })),
    // Arrays of objects that are not unwound yet, and why.
    not_unwound: registry.pending_unwinds ?? [],
    // Every index that can serve a query, including the GIN on the documents.
    indexes: queryIndexes(collection.id, registry),
  };
}

/**
 * One sentence for a timeout message when the collection's registry shows
 * index builds (projections or unwinds) that failed, so queries on those
 * fields read every document; undefined when there are none. One indexed
 * lookup of the collection row, run only after a timeout.
 */
export async function storageTimeoutHint(slug: string, userId: string): Promise<string | undefined> {
  const access = await findAccessibleCollection(slug, userId, "viewer");
  if (!access) return undefined;
  const failed = readRegistry(access.collection.storage).failed_ddl ?? [];
  if (failed.length === 0) return undefined;
  const names = failed.map((f) => {
    if (f.kind === "unwind") return f.key;
    try {
      const segments = JSON.parse(f.key);
      return Array.isArray(segments) ? segments.join(".") : f.key;
    } catch {
      return f.key;
    }
  });
  return `Building indexes for ${names.map((n) => `'${n}'`).join(", ")} on this collection failed (see hutch_get_collection storage.failed_ddl), so queries on those fields read every document until a later write retries them.`;
}
