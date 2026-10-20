import { db } from "@/lib/db";
import { collections, collectionMembers } from "@/lib/db/schema";
import { createCollectionWithOwner, findCollectionByNameInOrg, findCollectionByNameInsensitiveInOrg, findCollectionBySlugInOrg } from "@/lib/db/queries";
import { slugify, uniqueSlug, titleCase } from "@/lib/slugify";
import { eq, and, type SQL } from "drizzle-orm";
import { revalidateDashboard } from "@/lib/revalidation";
import { inferSchema, mergeSchema, detectNewFields, inferSchemaFromData, CollectionSchema } from "@/lib/schema-inference";
import { seedAutoViews } from "./views";
import { findAccessibleCollection } from "./resolve";
import { beforeCreateRecord, QuotaExceededError } from "@/lib/quota";
import { RECORD_STATUSES, REINFER_COOLDOWN_MS, MAX_RECORD_SIZE, FIELD_NAME_RE } from "@/lib/constants";
import { recordsToCsv, csvToRecords, type ExportRow } from "@/lib/csv";
import { isPlainObject } from "@/lib/validation";
import { readRegistry, type StorageRegistry } from "@/lib/storage/registry";
import { collectionTableExists, createCollectionTable, setUniqueKey } from "@/lib/storage/ddl";
import { applyInference, markMixedProjections, recheckMixedProjections, updateRegistry } from "@/lib/storage/apply";
import { queueDueIndexBuild } from "@/lib/storage/build-queue";
import * as tableRows from "@/lib/storage/rows";
import { COLLECTION_QUERY_CONCURRENCY, mapLimit } from "@/lib/map-limit";
import { queryTable, tableFilterWhere, type TableQueryParams } from "@/lib/storage/compiler";

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

/**
 * Resolve a write's raw collection argument to an existing collection.
 * Auto-create stores name = titleCase(raw) and slug = slugify(raw) + random
 * suffix, so a repeat write of "my_tasks" must match the stored "My Tasks";
 * exact name and exact slug alone never would.
 */
async function findCollectionForWrite(collectionName: string, organizationId: string) {
  return (
    (await findCollectionByNameInOrg(collectionName, organizationId)) ??
    (await findCollectionByNameInsensitiveInOrg([collectionName, titleCase(collectionName)], organizationId)) ??
    (await findCollectionBySlugInOrg(slugify(collectionName), organizationId))
  );
}

/** Unique violation on (organization_id, name). drizzle wraps pg errors in `cause`. */
function isCollectionNameConflict(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === "idx_collections_org_name") return true;
  }
  return false;
}

export async function createRecords(userId: string, organizationId: string, params: {
  collection: string;
  data?: Record<string, unknown>;
  records?: Record<string, unknown>[];
  on_conflict?: string;
  /** "summary" leaves the stored records out of the response (bulk loads). */
  return?: "records" | "summary";
}) {
  const { collection: collectionName, data: singleData, records: bulkRecords, on_conflict: onConflict = "replace", return: returnMode = "records" } = params;

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
  let collection = await findCollectionForWrite(collectionName, organizationId);

  let collectionWasCreated = false;
  if (!collection) {
    try {
      collection = await createCollectionWithOwner({
        organizationId,
        ownerUserId: userId,
        name: titleCase(collectionName),
        slug: uniqueSlug(collectionName),
      });
      collectionWasCreated = true;
    } catch (err) {
      // A concurrent write created the same name between our lookup and
      // insert — use the winner's collection instead of surfacing a 500.
      if (!isCollectionNameConflict(err)) throw err;
      collection = await findCollectionForWrite(collectionName, organizationId);
      if (!collection) throw err;
    }
  }

  const stored = await storeInTable(collection, recordsToInsert, onConflict, collectionWasCreated);
  if ("error" in stored) return stored;
  const results = stored.results;
  // The documents as stored (merged documents after an on_conflict merge),
  // which inference evaluates.
  const storedDocs = results.map((r) => r.record.data).filter(isPlainObject);

  // Auto-infer schema if records contain fields not yet in the schema
  const existingSchema = collection.schema as CollectionSchema | null;
  const hasNewFields = recordsToInsert.some((data) => detectNewFields(existingSchema, data));

  if (hasNewFields && shouldReinfer(existingSchema)) {
    await reinferCollectionSchema(collection.id, existingSchema);
  } else {
    await db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, collection.id));
  }

  // Storage inference (projections, unwinds, search index) runs after every
  // successful write and only queues builds; they run in the background
  // after the response (build-queue.ts). It must never fail the write.
  let storageNote: string | undefined;
  try {
    const before = readRegistry(collection.storage);
    await markMixedProjections(collection.id, storedDocs);
    const after = await applyInference(collection, storedDocs);
    storageNote = storageChangeNote(before, after);
    queueDueIndexBuild({ id: collection.id, storage: after });
  } catch (err) {
    console.error(`[storage] inference failed for collection ${collection.id}`, err);
  }

  revalidateDashboard(collection.slug);

  // Seed default views the first time this collection appears, using the
  // schema inferred from the records that just landed.
  if (collectionWasCreated) {
    const inferredFromData = inferSchemaFromData(recordsToInsert);
    await seedAutoViews(collection.slug, userId, inferredFromData);
  }

  const saved = buildSaveSummary(collection.name, results, collectionWasCreated);
  const summary = storageNote ? `${saved}${/[.)]$/.test(saved) ? "" : "."} ${storageNote}` : saved;
  const note = { ...slugNote(collection), ...(storageNote ? { storage_note: storageNote } : {}) };

  if (returnMode === "summary") {
    return {
      collection: { name: collection.name, slug: collection.slug },
      count: results.length,
      ...tallyActions(results),
      ...(bulkRecords ? {} : { action: results[0]?.action, id: (results[0]?.record as { id?: number } | undefined)?.id }),
      summary,
      ...note,
    };
  }

  if (bulkRecords) {
    return {
      collection: { name: collection.name, slug: collection.slug },
      results,
      count: results.length,
      summary,
      ...note,
    };
  }

  return {
    collection: { name: collection.name, slug: collection.slug },
    ...results[0],
    summary,
    ...note,
  };
}

/** Which identifier other tools take for this collection: the slug, and the exact name works too. */
export function slugNote(collection: { name: string; slug: string }): { use: string } {
  return { use: `Pass slug "${collection.slug}" to other tools for this collection; its name "${collection.name}" works too.` };
}

/**
 * What this write's inference queued — fields to index, arrays to unwind
 * into child tables, the full-text search index — and that they are built
 * in the background. Undefined when it queued nothing.
 */
export function storageChangeNote(before: StorageRegistry, after: StorageRegistry): string | undefined {
  const projected = after.projections.filter((p) => !before.projections.some((b) => b.column === p.column)).map((p) => p.field);
  const unwound = after.unwinds.filter((u) => !before.unwinds.some((b) => b.path === u.path)).map((u) => u.path);
  const search = after.search_index !== undefined && before.search_index === undefined;
  if (projected.length === 0 && unwound.length === 0 && !search) return undefined;
  const parts: string[] = [];
  if (projected.length > 0) parts.push(`indexes on ${projected.length === 1 ? "field" : "fields"} ${projected.map((f) => `'${f}'`).join(", ")}`);
  if (unwound.length > 0) parts.push(`unwinding ${unwound.map((p) => `'${p}'`).join(", ")} into ${unwound.length === 1 ? "a queryable table" : "queryable tables"} (so filters and aggregates on ${unwound.length === 1 ? "its" : "their"} elements can use indexes)`);
  if (search) parts.push("a full-text index for search");
  return `This batch queued ${parts.join(", ")}. They are built in the background shortly after this write (hutch_describe_collection shows each one's state under storage.indexes); until they are ready, queries return the same results without them.`;
}

type CollectionRow = typeof collections.$inferSelect;

type StoreResult = { results: { action: string; record: Record<string, unknown> }[] } | { error: string; status: number };

/**
 * Write path: the rows go to the collection's hc_<id> table.
 * Upserts use a unique index over the key (see hc_set_unique_key) and
 * honour every on_conflict mode (replace, merge, skip, error).
 */
async function storeInTable(
  collection: CollectionRow,
  docs: Record<string, unknown>[],
  onConflict: string,
  collectionWasCreated: boolean,
): Promise<StoreResult> {
  // createCollectionWithOwner creates the table; this covers a collection
  // inserted by other means.
  if (!collectionWasCreated && !(await collectionTableExists(db, collection.id))) {
    await createCollectionTable(db, collection.id);
  }

  const uniqueKey = (collection.uniqueKey as string[]) || [];
  if (uniqueKey.length === 0) {
    const inserted = await tableRows.insertRecords(collection.id, docs);
    return { results: inserted.map((record) => ({ action: "created", record: record as unknown as Record<string, unknown> })) };
  }

  const mode = onConflict === "skip" || onConflict === "error" || onConflict === "merge" ? onConflict : "replace";

  const keyError = await ensureUniqueKeyIndex(collection, uniqueKey);
  if (keyError) return keyError;

  const result = await tableRows.upsertRecords(collection.id, docs, uniqueKey, mode);
  if ("conflict" in result) {
    return { error: "Record with matching unique key already exists", status: 409 };
  }
  return { results: result.results.map((r) => ({ action: r.action, record: r.record as unknown as Record<string, unknown> })) };
}

/** Make the table's unique index match the collection's unique_key, if it changed. */
async function ensureUniqueKeyIndex(collection: CollectionRow, uniqueKey: string[]): Promise<{ error: string; status: number } | null> {
  const registry = readRegistry(collection.storage);
  if (JSON.stringify(registry.unique_key ?? []) === JSON.stringify(uniqueKey)) return null;
  try {
    await updateRegistry(collection.id, async (current, tx) => {
      if (JSON.stringify(current.unique_key ?? []) === JSON.stringify(uniqueKey)) return null;
      await setUniqueKey(tx, collection.id, uniqueKey);
      return { ...current, unique_key: uniqueKey };
    });
    return null;
  } catch (err) {
    const pg = (err as { cause?: { code?: string } }).cause ?? (err as { code?: string });
    if (pg && (pg as { code?: string }).code === "23505") {
      return { error: `Existing records already contain duplicates of unique key [${uniqueKey.join(", ")}] — remove them before storing with on_conflict`, status: 409 };
    }
    throw err;
  }
}

function tallyActions(results: { action: string }[]): { created: number; updated: number; skipped: number } {
  const counts = { created: 0, updated: 0, skipped: 0 };
  for (const r of results) {
    if (r.action === "created") counts.created++;
    else if (r.action === "updated") counts.updated++;
    else if (r.action === "skipped") counts.skipped++;
  }
  return counts;
}

function buildSaveSummary(
  collectionName: string,
  results: { action: string }[],
  collectionWasCreated: boolean,
): string {
  const counts = tallyActions(results);
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
  const access = await findAccessibleCollection(slug, userId, "viewer");
  if (!access) return null;
  const collection = access.collection;

  const clampedLimit = Math.min(limit, 200);

  const [recs, total] = await Promise.all([
    tableRows.listRecords(collection.id, clampedLimit, offset),
    tableRows.countRecords(collection.id),
  ]);
  return { records: recs, total, limit: clampedLimit, offset };
}

export async function queryRecords(slug: string, userId: string, params: Omit<TableQueryParams, 'limitCap'>) {
  const access = await findAccessibleCollection(slug, userId, "viewer");
  if (!access) return null;

  queueDueIndexBuild(access.collection);
  return queryTable(access.collection, params);
}

const EXPORT_DEFAULT_LIMIT = 1000;
const EXPORT_MAX_LIMIT = 10000;
const IMPORT_MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB — mirrored by the MCP zod schema
const EXPORT_MAX_CONTENT_BYTES = 50 * 1024 * 1024; // 50MB

function toIso(value: Date | null): string {
  return value ? value.toISOString() : "";
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
  sort?: string | string[];
  fields?: string[];
  limit?: number;
}) {
  const access = await findAccessibleCollection(slug, userId, "viewer");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;

  const format = params.format ?? "json";
  const limit = Math.min(Math.max(params.limit ?? EXPORT_DEFAULT_LIMIT, 1), EXPORT_MAX_LIMIT);

  const result = await queryTable(access.collection, {
    filter: params.filter,
    search: params.search,
    sort: params.sort,
    fields: params.fields,
    limit,
    limitCap: EXPORT_MAX_LIMIT,
  });

  // Type-narrowing assertion: exportRecords never passes aggregation params,
  // so the engine always returns the records shape. This narrows the union
  // for TypeScript; it is not a supported input path.
  if (!("records" in result)) {
    return { error: "Export does not support aggregation queries", status: 400 };
  }

  const rows: ExportRow[] = result.records.map((r) => ({
    id: r.id,
    created_at: toIso(r.createdAt),
    updated_at: toIso(r.updatedAt),
    data: isPlainObject(r.data) ? r.data : {},
  }));

  const content = format === "csv" ? recordsToCsv(rows) : JSON.stringify(rows);

  if (content.length > EXPORT_MAX_CONTENT_BYTES) {
    return { error: "Export exceeds 50MB — narrow with filter, fields, or a lower limit", status: 400 };
  }

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
  /** "records" echoes the stored records; the default is a summary. */
  return?: "records" | "summary";
}) {
  const { collection, format = "csv", content, on_conflict, return: returnMode = "summary" } = params;

  if (content.length > IMPORT_MAX_CONTENT_BYTES) {
    return { error: "Import content exceeds 10MB limit", status: 400 };
  }

  let recordsToStore: Record<string, unknown>[];

  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { error: "Invalid JSON content", status: 400 };
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (!items.every(isPlainObject)) {
      return { error: "JSON content must be an object or an array of objects", status: 400 };
    }
    // Unwrap hutch_export_records output ({id, created_at, updated_at, data})
    // so exports round-trip without nesting the data under a `data` key.
    recordsToStore = items.map((item) =>
      "id" in item && "created_at" in item && "updated_at" in item && isPlainObject(item.data)
        ? item.data
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

  if (recordsToStore.length > EXPORT_MAX_LIMIT) {
    return { error: `Import is limited to ${EXPORT_MAX_LIMIT} records per call`, status: 400 };
  }

  const result = await createRecords(userId, organizationId, {
    collection,
    records: recordsToStore,
    on_conflict,
    return: returnMode,
  });
  if ("error" in result) return result;

  const bulk = result as {
    collection: { name: string; slug: string };
    results?: { action: string; record: Record<string, unknown> }[];
    count?: number;
    created?: number;
    updated?: number;
    skipped?: number;
    summary?: string;
    use?: string;
    storage_note?: string;
  };

  const counts = bulk.results ? tallyActions(bulk.results) : { created: bulk.created ?? 0, updated: bulk.updated ?? 0, skipped: bulk.skipped ?? 0 };

  return {
    collection: bulk.collection,
    count: bulk.count ?? 0,
    ...counts,
    ...(returnMode === "records" && bulk.results ? { results: bulk.results } : {}),
    summary: bulk.summary,
    ...(bulk.use ? { use: bulk.use } : {}),
    ...(bulk.storage_note ? { storage_note: bulk.storage_note } : {}),
  };
}

/**
 * hutch_search: at most `limit` matches in total (max 50) across every
 * collection the user can read, the most relevant first (ts_rank), newest
 * first among equals. Each collection contributes at most `limit`
 * candidates, so the merged top `limit` is exact. Matches are grouped by
 * collection, groups in the order of their best match, and every record
 * keeps its collection's name and slug.
 */
export async function searchGlobal(userId: string, search: string, limit: number = 10) {
  if (!userId) return { search, results: [] };
  const clampedLimit = Math.max(1, Math.min(Math.trunc(limit) || 10, 50));

  const accessible = await db
    .select({ id: collections.id, name: collections.name, slug: collections.slug, storage: collections.storage })
    .from(collections)
    .innerJoin(
      collectionMembers,
      and(eq(collectionMembers.collectionId, collections.id), eq(collectionMembers.userId, userId))
    );
  for (const coll of accessible) queueDueIndexBuild(coll);
  // Bounded concurrency; results are concatenated in collection order, as
  // the serial loop did, so the stable sort below ranks ties the same way.
  const perCollection = await mapLimit(accessible, COLLECTION_QUERY_CONCURRENCY, async (coll) =>
    (await tableRows.searchRecords(coll.id, search, clampedLimit)).map((row) => ({ coll, row })));
  const candidates = perCollection.flat();
  const time = (d: Date | null) => d?.getTime() ?? 0;
  candidates.sort((a, b) =>
    b.row.rank - a.row.rank || time(b.row.createdAt) - time(a.row.createdAt) || b.row.id - a.row.id);

  const grouped = new Map<number, { collection: { name: string; slug: string }; records: Record<string, unknown>[] }>();
  for (const { coll, row } of candidates.slice(0, clampedLimit)) {
    let group = grouped.get(coll.id);
    if (!group) {
      group = { collection: { name: coll.name, slug: coll.slug }, records: [] };
      grouped.set(coll.id, group);
    }
    group.records.push({
      collectionName: coll.name,
      collectionSlug: coll.slug,
      id: row.id,
      collectionId: coll.id,
      data: row.data,
      source: row.source,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  const results = Array.from(grouped.values()).map((g) => ({
    collection: g.collection,
    matches: g.records.length,
    records: g.records,
  }));

  return { search, results };
}

export async function truncateRecords(slug: string, userId: string) {
  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collection = access.collection;

  await tableRows.softDeleteAll(collection.id);
  revalidateDashboard(slug);
  return { truncated: true, slug };
}

export async function updateRecord(slug: string, userId: string, recordId: number, data: Record<string, unknown>) {
  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const collection = access.collection;
  const updated = await tableRows.updateRecordData(collection.id, recordId, data);

  if (!updated) return { error: "Record not found", status: 404 };

  try {
    await markMixedProjections(collection.id, [data]);
  } catch (err) {
    console.error(`[storage] projection check failed for collection ${collection.id}`, err);
  }

  // Re-infer schema if the updated record has new fields
  const existingSchema = collection.schema as CollectionSchema | null;
  if (detectNewFields(existingSchema, data) && shouldReinfer(existingSchema)) {
    await reinferCollectionSchema(collection.id, existingSchema);
  } else {
    await db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, collection.id));
  }

  revalidateDashboard(slug);
  return { updated: true, record: updated, slug };
}

export async function transformRecords(slug: string, userId: string, params: {
  remove_fields?: string[];
  rename_fields?: Record<string, string>;
  set_field?: { field: string; value: unknown; filter?: Record<string, unknown> };
}) {
  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const { remove_fields, rename_fields, set_field } = params;

  const hasOperation =
    (remove_fields && remove_fields.length > 0) ||
    (rename_fields && Object.keys(rename_fields).length > 0) ||
    set_field !== undefined;
  if (!hasOperation) {
    return {
      error: "No transform operation provided — pass rename_fields, remove_fields, or set_field",
      status: 400,
    };
  }

  const fieldNames = [
    ...(remove_fields ?? []),
    ...Object.entries(rename_fields ?? {}).flat(),
    ...(set_field ? [set_field.field] : []),
  ];
  // Field names are validated by FIELD_NAME_RE (alphanumeric + underscore
  // only) before any statement runs.
  if (!fieldNames.every((f) => FIELD_NAME_RE.test(f))) {
    return { error: "Invalid field name", status: 400 };
  }

  // Database failures return this clean message instead of surfacing raw
  // driver/SQL text through the MCP tool output.
  const transformFailed = {
    error: "Transform failed while updating records — check the field names and values and try again",
    status: 500,
  };

  // set_field.filter takes the full query filter language (operators,
  // dotted paths, array elements), as in hutch_query_records.
  const collection = access.collection;
  let setFilter: SQL | undefined;
  if (set_field?.filter && Object.keys(set_field.filter).length > 0) {
    try {
      setFilter = await tableFilterWhere(collection, set_field.filter);
    } catch (err) {
      console.error(`transformRecords set_field filter failed for collection ${collection.id}`, err);
      return transformFailed;
    }
  }

  // The statements run in one transaction, so a failure leaves none of
  // them applied.
  let touched: Set<number>;
  try {
    const result = await tableRows.transformRows(collection.id, {
      remove_fields,
      rename_fields,
      set_field: set_field ? { field: set_field.field, value: set_field.value } : undefined,
      setFilter,
    });
    touched = new Set(result.touched);
  } catch (err) {
    if (err instanceof tableRows.TransformStepError) {
      console.error(`transformRecords ${err.step} failed for collection ${collection.id}`, err.cause);
      return transformFailed;
    }
    throw err;
  }

  if (touched.size > 0) {
    try {
      await recheckMixedProjections(collection.id);
    } catch (err) {
      console.error(`[storage] projection check failed for collection ${collection.id}`, err);
    }
  }

  // Re-infer schema if fields were added or renamed (skip for remove-only)
  const existingSchema = collection.schema as CollectionSchema | null;
  const needsReinference = !!(set_field || rename_fields) && touched.size > 0;
  if (needsReinference && shouldReinfer(existingSchema)) {
    await reinferCollectionSchema(collection.id, existingSchema);
  } else {
    await db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, collection.id));
  }

  revalidateDashboard(slug);
  return {
    transformed: true,
    slug,
    updated: touched.size,
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

  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const updated = await tableRows.setRecordStatus(access.collection.id, recordId, status);

  if (!updated) return { error: "Record not found", status: 404 };

  revalidateDashboard(slug);
  return { updated: true, record: updated, slug };
}

export async function deleteRecord(slug: string, userId: string, recordId: number) {
  const access = await findAccessibleCollection(slug, userId, "editor");
  if (!access) return null;
  // The argument may be the collection's name; continue with its slug.
  slug = access.collection.slug;
  const deleted = await tableRows.softDeleteRecord(access.collection.id, recordId);

  if (!deleted) return { error: "Record not found", status: 404 };
  revalidateDashboard(slug);
  return { deleted: true, id: recordId, slug };
}
