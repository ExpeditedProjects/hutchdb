import { db } from "@/lib/db";
import { collections, records, collectionMembers } from "@/lib/db/schema";
import { createCollectionWithOwner, findAccessibleCollectionBySlug, findCollectionByNameInOrg, findCollectionBySlugInOrg, getCollectionRecordCount, queryRecords as queryRecordsEngine, QueryParams, notDeleted } from "@/lib/db/queries";
import { slugify, uniqueSlug, titleCase } from "@/lib/slugify";
import { eq, and, sql, desc } from "drizzle-orm";
import { revalidateDashboard } from "@/lib/revalidation";
import { inferSchema, mergeSchema, detectNewFields, inferSchemaFromData, CollectionSchema } from "@/lib/schema-inference";
import { seedAutoViews } from "./views";
import { beforeCreateRecord, QuotaExceededError } from "@/lib/quota";
import { RECORD_STATUSES, REINFER_COOLDOWN_MS, MAX_RECORD_SIZE, FIELD_NAME_RE } from "@/lib/constants";
import { recordsToCsv, csvToRecords, type ExportRow } from "@/lib/csv";

async function reinferCollectionSchema(collectionId: number, existingSchema: CollectionSchema | null) {
  try {
    const inferred = await inferSchema(collectionId);
    const merged = mergeSchema(existingSchema, inferred);
    await db.update(collections).set({ schema: merged, updatedAt: new Date() }).where(eq(collections.id, collectionId));
  } catch {
    // Update lastInferredAt even on failure to prevent retrying on every write
    const failedSchema = { ...(existingSchema ?? { fields: [], version: 0 }), lastInferredAt: new Date().toISOString() };
    await db.update(collections).set({ schema: failedSchema, updatedAt: new Date() }).where(eq(collections.id, collectionId));
  }
}

function shouldReinfer(schema: CollectionSchema | null): boolean {
  if (!schema?.lastInferredAt) return true;
  return Date.now() - new Date(schema.lastInferredAt).getTime() > REINFER_COOLDOWN_MS;
}

export async function createRecords(userId: string, organizationId: string, params: {
  collection: string;
  data?: Record<string, unknown>;
  records?: Record<string, unknown>[];
  on_conflict?: string;
}) {
  const { collection: collectionName, data: singleData, records: bulkRecords, on_conflict: onConflict = "replace" } = params;

  if (!collectionName) {
    return { error: "Missing 'collection' field", status: 400 };
  }

  if (!singleData && !bulkRecords) {
    return { error: "Must provide 'data' or 'records'", status: 400 };
  }

  const recordsToInsert = bulkRecords || [singleData!];

  // Validate size and capture total bytes for the quota hook.
  let totalBytes = 0;
  for (const rec of recordsToInsert) {
    const size = JSON.stringify(rec).length;
    if (size > MAX_RECORD_SIZE) {
      return { error: "Record exceeds 1MB size limit", status: 413 };
    }
    totalBytes += size;
  }

  try {
    await beforeCreateRecord({
      userId,
      organizationId,
      collectionName,
      count: recordsToInsert.length,
      bytes: totalBytes,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, status: 413 };
    }
    throw err;
  }

  // Find or create collection within the caller's org
  let collection = await findCollectionByNameInOrg(collectionName, organizationId);
  if (!collection) {
    const slug = slugify(collectionName);
    collection = await findCollectionBySlugInOrg(slug, organizationId);
  }

  let collectionWasCreated = false;
  if (!collection) {
    collection = await createCollectionWithOwner({
      organizationId,
      ownerUserId: userId,
      name: titleCase(collectionName),
      slug: uniqueSlug(collectionName),
    });
    collectionWasCreated = true;
  }

  const uniqueKey = (collection.uniqueKey as string[]) || [];
  const results: { action: string; record: Record<string, unknown> }[] = [];

  if (uniqueKey.length === 0) {
    // Fast path: batch insert all records in a single query
    const created = await db
      .insert(records)
      .values(recordsToInsert.map((data) => ({
        collectionId: collection.id,
        data,
        source: "api" as const,
      })))
      .returning();
    for (const rec of created) {
      results.push({ action: "created", record: rec as unknown as Record<string, unknown> });
    }
  } else {
    // Upsert path: per-record conflict resolution
    for (const data of recordsToInsert) {
      const keyFilter: Record<string, unknown> = {};
      for (const field of uniqueKey) {
        if (data[field] !== undefined) {
          keyFilter[field] = data[field];
        }
      }

      if (Object.keys(keyFilter).length === uniqueKey.length) {
        const [existing] = await db
          .select()
          .from(records)
          .where(
            and(
              eq(records.collectionId, collection.id),
              sql`${records.data} @> ${JSON.stringify(keyFilter)}::jsonb`,
              notDeleted
            )
          )
          .limit(1);

        if (existing) {
          let newData: Record<string, unknown>;
          if (onConflict === "merge") {
            newData = { ...(existing.data as Record<string, unknown>), ...data };
          } else if (onConflict === "skip") {
            results.push({ action: "skipped", record: existing as unknown as Record<string, unknown> });
            continue;
          } else if (onConflict === "error") {
            return { error: "Record with matching unique key already exists", status: 409 };
          } else {
            newData = data;
          }

          const [updated] = await db
            .update(records)
            .set({ data: newData, updatedAt: new Date(), source: "api" })
            .where(eq(records.id, existing.id))
            .returning();
          results.push({ action: "updated", record: updated as unknown as Record<string, unknown> });
          continue;
        }
      }

      const [created] = await db
        .insert(records)
        .values({
          collectionId: collection.id,
          data,
          source: "api",
        })
        .returning();
      results.push({ action: "created", record: created as unknown as Record<string, unknown> });
    }
  }

  // Auto-infer schema if records contain fields not yet in the schema
  const existingSchema = collection.schema as CollectionSchema | null;
  const hasNewFields = recordsToInsert.some((data) => detectNewFields(existingSchema, data));

  if (hasNewFields && shouldReinfer(existingSchema)) {
    await reinferCollectionSchema(collection.id, existingSchema);
  } else {
    await db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, collection.id));
  }

  revalidateDashboard(collection.slug);

  // Seed default views the first time this collection appears, using the
  // schema inferred from the records that just landed.
  if (collectionWasCreated) {
    const inferredFromData = inferSchemaFromData(recordsToInsert);
    await seedAutoViews(collection.slug, userId, inferredFromData);
  }

  const summary = buildSaveSummary(collection.name, results, collectionWasCreated);

  if (bulkRecords) {
    return {
      collection: { name: collection.name, slug: collection.slug },
      results,
      count: results.length,
      summary,
    };
  }

  return {
    collection: { name: collection.name, slug: collection.slug },
    ...results[0],
    summary,
  };
}

function buildSaveSummary(
  collectionName: string,
  results: { action: string }[],
  collectionWasCreated: boolean,
): string {
  const counts = { created: 0, updated: 0, skipped: 0 };
  for (const r of results) {
    if (r.action === "created") counts.created++;
    else if (r.action === "updated") counts.updated++;
    else if (r.action === "skipped") counts.skipped++;
  }
  const total = counts.created + counts.updated + counts.skipped;
  const noun = total === 1 ? "record" : "records";

  // Pick a headline verb. Saved (created) wins if any were created; otherwise
  // Updated wins if any were updated; else Skipped.
  let headline: string;
  let preposition: "to" | "in";
  if (counts.created > 0) {
    headline = "Saved";
    preposition = "to";
  } else if (counts.updated > 0) {
    headline = "Updated";
    preposition = "in";
  } else {
    headline = "Skipped";
    preposition = "in";
  }

  // When the collection was auto-created, the prefix already names it, so
  // drop the trailing " <preposition> <Name>" clause and use a period.
  if (collectionWasCreated) {
    return `Created ${collectionName}. ${headline} ${total} ${noun}.`;
  }

  // Mixed-action breakdown in parentheses (created, updated, skipped — omit zeroes).
  const breakdown: string[] = [];
  if (counts.created > 0) breakdown.push(`${counts.created} created`);
  if (counts.updated > 0) breakdown.push(`${counts.updated} updated`);
  if (counts.skipped > 0) breakdown.push(`${counts.skipped} skipped`);
  const isMixed = breakdown.length > 1;
  const suffix = isMixed ? ` (${breakdown.join(", ")})` : "";

  return `${headline} ${total} ${noun} ${preposition} ${collectionName}${suffix}`;
}

export async function listRecords(slug: string, userId: string, limit: number = 50, offset: number = 0) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "viewer");
  if (!access) return null;
  const collection = access.collection;

  const clampedLimit = Math.min(limit, 200);

  const recs = await db
    .select()
    .from(records)
    .where(and(eq(records.collectionId, collection.id), notDeleted))
    .orderBy(desc(records.createdAt))
    .limit(clampedLimit)
    .offset(offset);

  const total = await getCollectionRecordCount(collection.id);

  return { records: recs, total, limit: clampedLimit, offset };
}

export async function queryRecords(slug: string, userId: string, params: Omit<QueryParams, 'collectionId'>) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "viewer");
  if (!access) return null;

  return queryRecordsEngine({ ...params, collectionId: access.collection.id });
}

export const EXPORT_DEFAULT_LIMIT = 1000;
export const EXPORT_MAX_LIMIT = 10000;

function toIso(value: Date | string | null | undefined): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Export a collection's records as serialized JSON or CSV text. Honors the
 * same filter/search/sort/fields params as queryRecords; limit defaults to
 * 1000 and caps at 10000. Returns the content plus count/truncated metadata.
 */
export async function exportRecords(slug: string, userId: string, params: {
  format?: "json" | "csv";
  filter?: Record<string, unknown>;
  search?: string;
  sort?: string;
  fields?: string[];
  limit?: number;
}) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "viewer");
  if (!access) return null;

  const format = params.format ?? "json";
  const limit = Math.min(Math.max(params.limit ?? EXPORT_DEFAULT_LIMIT, 1), EXPORT_MAX_LIMIT);

  const result = await queryRecordsEngine({
    collectionId: access.collection.id,
    filter: params.filter,
    search: params.search,
    sort: params.sort,
    fields: params.fields,
    limit,
    limitCap: EXPORT_MAX_LIMIT,
  });

  if (!("records" in result)) {
    return { error: "Export does not support aggregation queries", status: 400 };
  }

  const rows: ExportRow[] = result.records.map((r) => ({
    id: r.id,
    created_at: toIso(r.createdAt),
    updated_at: toIso(r.updatedAt),
    data: (typeof r.data === "object" && r.data !== null && !Array.isArray(r.data)
      ? r.data
      : {}) as Record<string, unknown>,
  }));

  const content = format === "csv" ? recordsToCsv(rows) : JSON.stringify(rows, null, 2);

  return {
    collection: { name: access.collection.name, slug: access.collection.slug },
    format,
    count: rows.length,
    total: result.total,
    truncated: result.has_more,
    content,
  };
}

/**
 * Import records from CSV or JSON text. Parsing happens here; storage goes
 * through createRecords so unique_key/on_conflict/quota logic is honored.
 * The bulky per-record results array is summarized down to counts.
 */
export async function importRecords(userId: string, organizationId: string, params: {
  collection: string;
  format?: "csv" | "json";
  content: string;
  on_conflict?: string;
}) {
  const { collection, format = "csv", content, on_conflict } = params;

  let recordsToStore: Record<string, unknown>[];

  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { error: "Invalid JSON content", status: 400 };
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (!items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      return { error: "JSON content must be an object or an array of objects", status: 400 };
    }
    // Unwrap hutch_export_records output ({id, created_at, updated_at, data})
    // so exports round-trip without nesting the data under a `data` key.
    recordsToStore = (items as Record<string, unknown>[]).map((item) =>
      "id" in item && "created_at" in item && "updated_at" in item &&
      typeof item.data === "object" && item.data !== null && !Array.isArray(item.data)
        ? (item.data as Record<string, unknown>)
        : item
    );
  } else {
    const parsed = csvToRecords(content);
    if ("error" in parsed) return { error: parsed.error, status: 400 };
    recordsToStore = parsed.records;
  }

  if (recordsToStore.length === 0) {
    return { error: "No records found in content", status: 400 };
  }

  const result = await createRecords(userId, organizationId, {
    collection,
    records: recordsToStore,
    on_conflict,
  });
  if ("error" in result) return result;

  // We always pass `records`, so createRecords took the bulk branch.
  const bulk = result as {
    collection: { name: string; slug: string };
    results?: { action: string }[];
    count?: number;
    summary?: string;
  };

  const counts = { created: 0, updated: 0, skipped: 0 };
  for (const r of bulk.results ?? []) {
    if (r.action === "created") counts.created++;
    else if (r.action === "updated") counts.updated++;
    else if (r.action === "skipped") counts.skipped++;
  }

  return {
    collection: bulk.collection,
    count: bulk.count ?? 0,
    ...counts,
    summary: bulk.summary,
  };
}

export async function searchGlobal(userId: string, search: string, limit: number = 10) {
  if (!userId) return { search, results: [] };
  const clampedLimit = Math.min(limit, 50);

  const matches = await db
    .select({
      collectionName: collections.name,
      collectionSlug: collections.slug,
      id: records.id,
      collectionId: records.collectionId,
      data: records.data,
      source: records.source,
      deletedAt: records.deletedAt,
      createdAt: records.createdAt,
      updatedAt: records.updatedAt,
    })
    .from(records)
    .innerJoin(collections, eq(records.collectionId, collections.id))
    .innerJoin(
      collectionMembers,
      and(eq(collectionMembers.collectionId, collections.id), eq(collectionMembers.userId, userId))
    )
    .where(
      and(
        sql`to_tsvector('english', ${records.data}::text) @@ plainto_tsquery('english', ${search})`,
        notDeleted
      )
    )
    .limit(clampedLimit * 10);

  const grouped = new Map<number, { collection: { name: string; slug: string }; records: typeof matches }>();
  for (const row of matches) {
    if (!grouped.has(row.collectionId)) {
      grouped.set(row.collectionId, {
        collection: { name: row.collectionName, slug: row.collectionSlug },
        records: [],
      });
    }
    const group = grouped.get(row.collectionId)!;
    if (group.records.length < clampedLimit) {
      group.records.push(row);
    }
  }

  const results = Array.from(grouped.values()).map((g) => ({
    collection: g.collection,
    matches: g.records.length,
    records: g.records,
  }));

  return { search, results };
}

export async function truncateRecords(slug: string, userId: string) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
  const collection = access.collection;

  await db.update(records).set({ deletedAt: new Date() }).where(and(eq(records.collectionId, collection.id), notDeleted));
  revalidateDashboard(slug);
  return { truncated: true, slug };
}

export async function updateRecord(slug: string, userId: string, recordId: number, data: Record<string, unknown>) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
  const collection = access.collection;

  const [updated] = await db
    .update(records)
    .set({ data, updatedAt: new Date() })
    .where(and(eq(records.id, recordId), eq(records.collectionId, collection.id), notDeleted))
    .returning();

  if (!updated) return { error: "Record not found", status: 404 };

  // Re-infer schema if the updated record has new fields
  const existingSchema = collection.schema as CollectionSchema | null;
  if (detectNewFields(existingSchema, data) && shouldReinfer(existingSchema)) {
    await reinferCollectionSchema(collection.id, existingSchema);
  } else {
    await db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, collection.id));
  }

  revalidateDashboard(slug);
  return { updated: true, record: updated };
}

export async function transformRecords(slug: string, userId: string, params: {
  remove_fields?: string[];
  rename_fields?: Record<string, string>;
  set_field?: { field: string; value: unknown; filter?: Record<string, unknown> };
}) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
  const collection = access.collection;

  const { remove_fields, rename_fields, set_field } = params;
  let totalUpdated = 0;

  if (remove_fields && remove_fields.length > 0) {
    for (const field of remove_fields) {
      if (!FIELD_NAME_RE.test(field)) {
        return { error: "Invalid field name", status: 400 };
      }
    }
    // Remove all fields in a single query using array subtraction
    // Field names are validated by FIELD_NAME_RE (alphanumeric + underscore only)
    const fieldsLiteral = `{${remove_fields.join(",")}}`;
    const result = await db.execute(
      sql`UPDATE records SET data = data - ${fieldsLiteral}::text[], updated_at = now()
          WHERE collection_id = ${collection.id} AND deleted_at IS NULL`
    );
    totalUpdated += result.rowCount ?? 0;
  }

  if (rename_fields && Object.keys(rename_fields).length > 0) {
    for (const [oldName, newName] of Object.entries(rename_fields)) {
      if (!FIELD_NAME_RE.test(oldName) || !FIELD_NAME_RE.test(newName)) {
        return { error: "Invalid field name", status: 400 };
      }
      const result = await db.execute(
        sql`UPDATE records
            SET data = (data || jsonb_build_object(${newName}, data->${oldName})) - ${oldName},
                updated_at = now()
            WHERE collection_id = ${collection.id}
            AND data ? ${oldName}
            AND deleted_at IS NULL`
      );
      totalUpdated += result.rowCount ?? 0;
    }
  }

  if (set_field) {
    const { field, value, filter } = set_field;
    if (!FIELD_NAME_RE.test(field)) {
      return { error: "Invalid field name", status: 400 };
    }
    const overlay = JSON.stringify({ [field]: value });
    let result;
    if (filter && Object.keys(filter).length > 0) {
      result = await db.execute(
        sql`UPDATE records
            SET data = data || ${overlay}::jsonb,
                updated_at = now()
            WHERE collection_id = ${collection.id}
            AND data @> ${JSON.stringify(filter)}::jsonb
            AND deleted_at IS NULL`
      );
    } else {
      result = await db.execute(
        sql`UPDATE records
            SET data = data || ${overlay}::jsonb,
                updated_at = now()
            WHERE collection_id = ${collection.id}
            AND deleted_at IS NULL`
      );
    }
    totalUpdated += result.rowCount ?? 0;
  }

  // Re-infer schema if fields were added or renamed (skip for remove-only)
  const existingSchema = collection.schema as CollectionSchema | null;
  const needsReinference = !!(set_field || rename_fields) && totalUpdated > 0;
  if (needsReinference && shouldReinfer(existingSchema)) {
    await reinferCollectionSchema(collection.id, existingSchema);
  } else {
    await db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, collection.id));
  }

  revalidateDashboard(slug);
  return {
    transformed: true,
    slug,
    updated: totalUpdated,
    operations: {
      ...(remove_fields ? { removed: remove_fields } : {}),
      ...(rename_fields ? { renamed: rename_fields } : {}),
      ...(set_field ? { set: set_field } : {}),
    },
  };
}

export async function updateRecordStatus(slug: string, userId: string, recordId: number, status: string) {
  if (!(RECORD_STATUSES as readonly string[]).includes(status)) {
    return { error: `Invalid status. Must be one of: ${RECORD_STATUSES.join(", ")}`, status: 400 };
  }

  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
  const collection = access.collection;

  const [updated] = await db
    .update(records)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(records.id, recordId), eq(records.collectionId, collection.id), notDeleted))
    .returning();

  if (!updated) return { error: "Record not found", status: 404 };

  revalidateDashboard(slug);
  return { updated: true, record: updated };
}

export async function deleteRecord(slug: string, userId: string, recordId: number) {
  const access = await findAccessibleCollectionBySlug(slug, userId, "editor");
  if (!access) return null;
  const collection = access.collection;

  const [existing] = await db
    .select({ id: records.id })
    .from(records)
    .where(and(eq(records.id, recordId), eq(records.collectionId, collection.id), notDeleted))
    .limit(1);

  if (!existing) return { error: "Record not found", status: 404 };

  await db.update(records).set({ deletedAt: new Date() }).where(eq(records.id, recordId));
  revalidateDashboard(slug);
  return { deleted: true, id: recordId };
}
