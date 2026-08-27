import { db } from "@/lib/db";
import { collections, records, collectionMembers, organizations, user, type CollectionRole } from "@/lib/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { eq, and, isNull, sql, desc } from "drizzle-orm";
import { createCollectionWithOwner, findAccessibleCollectionBySlug, getCollectionRecordCount, notDeleted } from "@/lib/db/queries";
import { describeCollection as describeCollectionFields } from "@/lib/describe";
import { uniqueSlug } from "@/lib/slugify";
import { revalidateDashboard } from "@/lib/revalidation";
import { inferSchema, mergeSchema, CollectionSchema, FieldDefinition, isSelectableField, MAX_OPTION_VALUE_LENGTH, MAX_OPTIONS_PER_FIELD } from "@/lib/schema-inference";
import { DEFAULT_RECORD_STATUS, FIELD_NAME_RE, MAX_FIELD_NAME_LENGTH } from "@/lib/constants";
import { validateTrimmedLength } from "@/lib/validation";
import { seedAutoViews } from "./views";

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
 * One aggregated query: COUNT/MAX over a LEFT JOIN to records replaces
 * the per-row correlated subqueries.
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
      recordCount: sql<number>`count(${records.id})::int`,
      lastRecordAt: sql<string | null>`max(${records.createdAt})::text`,
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
    .leftJoin(records, and(eq(records.collectionId, collections.id), isNull(records.deletedAt)))
    .groupBy(collections.id, collectionMembers.role, organizations.id)
    .orderBy(desc(collections.updatedAt))
    .limit(limit);

  return rows.map((r) => ({ ...r, role: r.role as CollectionRole }));
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

  return db
    .select({
      id: collections.id,
      name: collections.name,
      slug: collections.slug,
      recordCount: sql<number>`(SELECT count(*)::int FROM records r WHERE r.collection_id = "collections"."id" AND r.deleted_at IS NULL)`,
      viewCount: sql<number>`(SELECT count(*)::int + 1 FROM views v WHERE v.collection_id = "collections"."id")`,
      role: sql<CollectionRole>`${callerMember.role}`,
      ownerName: user.name,
      ownerEmail: user.email,
      updatedAt: collections.updatedAt,
      lastRecordAt: sql<string | null>`(SELECT max(created_at)::text FROM records r WHERE r.collection_id = "collections"."id" AND r.deleted_at IS NULL)`,
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
      recordCount: sql<number>`(SELECT count(*)::int FROM records WHERE records.collection_id = ${collections.id} AND deleted_at IS NULL)`,
      lastRecordAt: sql<string>`(SELECT max(created_at) FROM records WHERE records.collection_id = ${collections.id} AND deleted_at IS NULL)`,
    })
    .from(collections)
    .innerJoin(
      collectionMembers,
      and(eq(collectionMembers.collectionId, collections.id), eq(collectionMembers.userId, userId))
    )
    .where(and(...conditions))
    .orderBy(desc(collections.updatedAt));

  if (colls.length === 0) return [];

  const collIds = colls.map((c) => c.id);
  const fieldRows = await db.execute(
    sql`SELECT r.collection_id, jsonb_object_keys(r.data) AS field_name
        FROM (
          SELECT DISTINCT ON (collection_id, data) collection_id, data
          FROM records
          WHERE collection_id = ANY(${sql.raw(`ARRAY[${collIds.join(',')}]`)})
            AND deleted_at IS NULL
          LIMIT ${colls.length * 10}
        ) r`
  );

  const fieldsByCollection = new Map<number, Set<string>>();
  for (const row of fieldRows.rows as { collection_id: number; field_name: string }[]) {
    if (!fieldsByCollection.has(row.collection_id)) {
      fieldsByCollection.set(row.collection_id, new Set());
    }
    fieldsByCollection.get(row.collection_id)!.add(row.field_name);
  }

  return colls.map((coll) => ({
    ...coll,
    fields: Array.from(fieldsByCollection.get(coll.id) || []).sort(),
  }));
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

export async function getCollection(slug: string, userId: string) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "viewer");
  if (!access) return null;
  const collection = access.collection;

  const [recordCount, [lastRecord]] = await Promise.all([
    getCollectionRecordCount(collection.id),
    db
      .select({ lastAt: sql<string>`max(created_at)` })
      .from(records)
      .where(and(eq(records.collectionId, collection.id), notDeleted)),
  ]);

  return {
    ...collection,
    role: access.role,
    recordCount,
    lastRecordAt: lastRecord?.lastAt,
  };
}

export async function updateCollection(slug: string, userId: string, updates: Record<string, unknown>) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "owner");
  if (!access) return { error: "Collection not found", status: 404 };
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
  const access = await findAccessibleCollectionBySlug(slug, userId, "owner");
  if (!access) return { error: "Collection not found", status: 404 };

  await db.delete(collections).where(eq(collections.id, access.collection.id));
  revalidateDashboard(slug);
  return { deleted: true, slug };
}

export async function inferCollectionSchema(slug: string, userId: string) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
  const collection = access.collection;

  const inferred = await inferSchema(collection.id);
  const existingSchema = collection.schema as CollectionSchema | null;
  const merged = mergeSchema(existingSchema, inferred);

  await db.update(collections).set({ schema: merged, updatedAt: new Date() }).where(eq(collections.id, collection.id));
  revalidateDashboard(slug, "schema");

  return { schema: merged };
}

export async function updateFieldDefinition(
  slug: string,
  userId: string,
  fieldName: string,
  updates: Partial<Pick<FieldDefinition, "type" | "options" | "position" | "hidden">>
) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
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

  return { field: schema.fields[fieldIndex] };
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

  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
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

  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
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
  const access = await findAccessibleCollectionBySlug(slug, userId, "viewer");
  if (!access) return null;
  const collection = access.collection;

  const [summaryResult, statusResult, fieldResult] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS record_count,
             min(created_at)::text AS first_created_at,
             max(created_at)::text AS last_created_at,
             min(updated_at)::text AS first_updated_at,
             max(updated_at)::text AS last_updated_at,
             coalesce(sum(pg_column_size(data)), 0)::bigint AS approx_storage_bytes
      FROM records
      WHERE collection_id = ${collection.id} AND deleted_at IS NULL`),
    db.execute(sql`
      SELECT status, count(*)::int AS count
      FROM records
      WHERE collection_id = ${collection.id} AND deleted_at IS NULL
      GROUP BY status`),
    db.execute(sql`
      SELECT key, count(*)::int AS count
      FROM records, LATERAL jsonb_object_keys(data) AS key
      WHERE collection_id = ${collection.id} AND deleted_at IS NULL
        AND jsonb_typeof(data) = 'object'
      GROUP BY key
      ORDER BY count DESC, key ASC
      LIMIT ${STATS_MAX_FIELDS}`),
  ]);

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

export async function describeCollection(slug: string, userId: string) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "viewer");
  if (!access) return null;
  const collection = access.collection;

  const recordCount = await getCollectionRecordCount(collection.id);
  const fields = await describeCollectionFields(collection.id, recordCount);

  return {
    name: collection.name,
    slug: collection.slug,
    description: collection.description,
    recordCount,
    uniqueKey: collection.uniqueKey,
    fields,
  };
}
