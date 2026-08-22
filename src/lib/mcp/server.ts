import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as collectionService from "@/lib/services/collections";
import * as recordService from "@/lib/services/records";
import * as fileService from "@/lib/services/files";
import { createView } from "@/lib/services/views";
import { VIEW_TYPES } from "@/lib/views/types";
import { FILTER_OPERATORS } from "@/lib/db/queries";

const SERVER_INSTRUCTIONS = `Hutch Core stores structured data for a single AI agent user. Records are arbitrary JSON, grouped into collections.

Workflow for answering questions about stored data:
1. hutch_list_collections — see what exists
2. hutch_describe_collection — learn its fields and types
3. hutch_query_records — fetch with filters/search

Collections auto-create on the first hutch_store_records. No setup step.

Use filter for exact/numeric/enum matches, search for free-text across string fields, or combine both. Run hutch_describe_collection first when you don't know a field's type. Filters also accept Mongo-style operator objects per field: $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $contains (e.g. {"price": {"$gte": 10}}).

Use hutch_collection_stats for a quick overview of a collection's size and field coverage, and hutch_export_records / hutch_import_records to move data in and out as CSV or JSON.

For deduplication: set unique_key via hutch_update_collection, then hutch_store_records honors on_conflict (default: replace).

Views (hutch_create_view) save a table/kanban/gallery configuration on a collection so subsequent queries can reuse it.

Files: hutch_put_file stores a file at a path inside a collection (auto-created with upsert-on-path), hutch_get_file reads it back, hutch_list_files lists metadata. Small UTF-8 text lives inline in the record; larger or binary content (send content_base64) goes to S3-compatible blob storage and downloads via a presigned URL — blob storage requires the HUTCH_S3_* env vars. Max file size: 4MB.

This is the headless single-user Core. Multi-user sharing, organizations, invitations, and published dashboards live in Hutch Cloud (app.hutchdb.com), not here.`;

type McpToolResponse = { content: { type: "text"; text: string }[]; isError?: boolean };

// Shared between hutch_query_records and hutch_export_records — the same
// filter param flows to the same query engine in both.
const FILTER_DESCRIPTION =
  "Filter on record fields. Plain values are JSONB containment (exact) matches, e.g. {\"status\": \"active\"}. " +
  `A field value that is an object whose keys all start with $ applies operators instead: ${FILTER_OPERATORS.join(", ")}. ` +
  "$gt/$gte/$lt/$lte compare (number operands numerically, string operands — including ISO dates — lexicographically as text); " +
  "$ne is not-equal (also matches records missing the field); $in/$nin take an array of values; $exists takes a boolean; " +
  "$contains is a case-insensitive substring match on string fields. " +
  "Example: {\"price\": {\"$gte\": 10, \"$lt\": 100}, \"status\": {\"$in\": [\"active\", \"pending\"]}}";

function textResponse(text: string): McpToolResponse {
  return { content: [{ type: "text", text }] };
}

function errorResponse(text: string): McpToolResponse {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResponse(value: unknown): McpToolResponse {
  return textResponse(JSON.stringify(value, null, 2));
}

/**
 * Shared by hutch_store_records and hutch_import_records: attach the
 * collection URL and lead with the human-readable summary when present.
 */
function summarizedWriteResponse(result: object, collectionUrl: (slug: string) => string): McpToolResponse {
  const slug = (result as { collection?: { slug?: string } }).collection?.slug;
  const enriched = slug ? { ...result, url: collectionUrl(slug) } : result;
  const json = JSON.stringify(enriched, null, 2);
  const summary = (result as { summary?: string }).summary;
  return textResponse(summary ? `${summary}\n\n${json}` : json);
}

function collectionNotFound(slug: string): McpToolResponse {
  return errorResponse(
    `Collection '${slug}' not found. Call hutch_list_collections to see available slugs, or use hutch_store_records to create a new one by writing to it.`
  );
}

export function createMcpServer(userId: string, organizationId: string, baseUrl: string) {
  const server = new McpServer(
    {
      name: "hutch",
      version: "1.0.0",
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const collectionUrl = (slug: string) => `${baseUrl}/c/${slug}`;

  server.registerTool(
    "hutch_list_collections",
    {
      description: "List every collection the user has stored, with id, name, slug, and record count. Example: use when the user asks 'what data do I have in Hutch?'.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const collections = await collectionService.listCollections(userId);
      return jsonResponse(collections);
    }
  );

  server.registerTool(
    "hutch_get_collection",
    {
      description: "Get one collection's metadata, settings, and record count by slug. Example: use when the user asks 'how big is my bookmarks collection?'.",
      inputSchema: { slug: z.string().describe("Collection slug") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.getCollection(slug, userId);
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_describe_collection",
    {
      description: "Describe a collection's field names, types, and sample values. Example: call before hutch_query_records when you don't know what fields exist or whether to filter vs search.",
      inputSchema: { slug: z.string().describe("Collection slug") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.describeCollection(slug, userId);
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_store_records",
    {
      description: "Save one or many records to a collection (auto-creates the collection if new). Example: use when the user says 'save this' or has just produced structured output worth keeping for later.",
      inputSchema: {
        collection: z.string().describe("Collection name (e.g. 'bookmarks', 'notes', 'research'). Created automatically if new."),
        data: z.record(z.string(), z.unknown()).optional().describe("Single record as a JSON object (e.g. {\"title\": \"My note\", \"tags\": [\"work\"]}). Use this OR records, not both."),
        records: z.array(z.record(z.string(), z.unknown())).optional().describe("Array of record objects for storing multiple items at once (e.g. [{\"title\": \"A\"}, {\"title\": \"B\"}])"),
        on_conflict: z.enum(["replace", "merge", "skip", "error"]).optional().describe("What to do if a record with the same unique key exists. Default: replace"),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.createRecords(userId, organizationId, {
        collection: params.collection,
        data: params.data as Record<string, unknown> | undefined,
        records: params.records as Record<string, unknown>[] | undefined,
        on_conflict: params.on_conflict,
      });
      if ('error' in result) {
        return errorResponse(result.error as string);
      }
      return summarizedWriteResponse(result, collectionUrl);
    }
  );

  server.registerTool(
    "hutch_query_records",
    {
      description: "Fetch records from a collection with filter, search, sort, group_by, aggregate, time_bucket, and pagination. Example: use when the user asks 'show me bookmarks tagged work from last week'.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        filter: z.record(z.string(), z.unknown()).optional().describe(FILTER_DESCRIPTION),
        search: z.string().optional().describe("Full-text search query. Use for free-text across string fields."),
        sort: z.string().optional().describe("Sort field, prefix with - for descending (e.g. \"-created_at\")"),
        fields: z.array(z.string()).optional().describe("Projection: top-level data keys to include in each returned record's data (e.g. [\"title\", \"url\"]). System fields id/status/created_at/updated_at are always returned."),
        group_by: z.string().optional().describe("Field to group by for aggregation (e.g. \"status\")"),
        aggregate: z.record(z.string(), z.unknown()).optional().describe("Aggregation spec mapping result alias to \"count\" or {op: field} where op is min/max/distinct/sum/avg (e.g. {\"total\": \"count\", \"revenue\": {\"sum\": \"amount\"}}). sum/avg only aggregate numeric values and return null when a field has none."),
        time_bucket: z.string().optional().describe("Time bucket (hour, day, week, month, year)"),
        created_after: z.string().optional().describe("Filter records created after this ISO date (e.g. \"2026-07-01\" or \"2026-07-01T12:00:00Z\")"),
        created_before: z.string().optional().describe("Filter records created before this ISO date (e.g. \"2026-07-18\")"),
        limit: z.number().optional().describe("Max records to return (default 50, max 1000)"),
        offset: z.number().optional().describe("Offset for pagination"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.queryRecords(params.slug, userId, {
        filter: params.filter as Record<string, unknown> | undefined,
        search: params.search,
        sort: params.sort,
        fields: params.fields,
        groupBy: params.group_by,
        aggregate: params.aggregate as Record<string, string | Record<string, string>> | undefined,
        timeBucket: params.time_bucket,
        createdAfter: params.created_after,
        createdBefore: params.created_before,
        limit: params.limit,
        offset: params.offset,
      });
      if (!result) return collectionNotFound(params.slug);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_search",
    {
      description: "Full-text search across every collection the user has access to. Example: use when the user is looking for something but doesn't know which collection holds it.",
      inputSchema: {
        search: z.string().describe("What to search for — matches against all fields in all collections"),
        limit: z.number().optional().describe("Max results per collection (default 10, max 50)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.searchGlobal(userId, params.search, params.limit);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_collection_stats",
    {
      description: "Get statistics for one collection: record_count, counts by status, first/last created_at and updated_at, approximate storage bytes, and per-field fill rates (for each top-level key: how many records have it and what percent, most common first, capped at 50 keys). Fill rates are exact counts over all records (hutch_describe_collection's frequency is sampled). Example: use before a bulk cleanup, or when the user asks 'how complete is my contacts data?' or 'how big is this collection really?'.",
      inputSchema: { slug: z.string().describe("Collection slug") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.getCollectionStats(slug, userId);
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_export_records",
    {
      description: "Export a collection's records as JSON or CSV text. Accepts the same filter/search/sort/fields params as hutch_query_records, plus limit (default 1000, max 10000). Returns count, total, a truncated flag, and the serialized content. CSV columns are id, created_at, updated_at, then the union of top-level record fields; nested objects/arrays are JSON-stringified into their cell. CSV cells are written verbatim (no spreadsheet formula-escaping) so exports round-trip. Example: use when the user says 'give me my contacts as a CSV' or when handing data to a tool that wants a flat file.",
      inputSchema: {
        collection: z.string().describe("Collection slug"),
        format: z.enum(["json", "csv"]).optional().describe("Output format. Default: json"),
        filter: z.record(z.string(), z.unknown()).optional().describe(FILTER_DESCRIPTION),
        search: z.string().optional().describe("Full-text search query applied before export"),
        sort: z.string().optional().describe("Sort field, prefix with - for descending (e.g. \"-created_at\")"),
        fields: z.array(z.string()).optional().describe("Top-level data keys to include (CSV data columns / JSON data keys). Omit for all fields."),
        limit: z.number().optional().describe("Max records to export (default 1000, max 10000). Check the truncated flag in the response."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.exportRecords(params.collection, userId, {
        format: params.format,
        filter: params.filter as Record<string, unknown> | undefined,
        search: params.search,
        sort: params.sort,
        fields: params.fields,
        limit: params.limit,
      });
      if (!result) return collectionNotFound(params.collection);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_import_records",
    {
      description: "Import records into a collection from CSV or JSON text (auto-creates the collection if new; honors unique_key and on_conflict exactly like hutch_store_records). CSV requires a header row; numeric strings become numbers, true/false become booleans, empty cells are omitted, JSON-looking cells ({...} or [...]) are parsed, and id/created_at/updated_at columns are ignored — so hutch_export_records output round-trips cleanly. Example: use when the user pastes a spreadsheet export and says 'load this into Hutch'. For records you already hold as JSON objects, hutch_store_records is the more direct path.",
      inputSchema: {
        collection: z.string().describe("Collection name or slug (created automatically if new)"),
        format: z.enum(["csv", "json"]).optional().describe("Content format. Default: csv"),
        content: z.string().max(10 * 1024 * 1024).describe("Raw CSV text (header row required) or a JSON array of objects. Max 10MB."),
        on_conflict: z.enum(["replace", "merge", "skip", "error"]).optional().describe("What to do when a record matches an existing unique key. Default: replace"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.importRecords(userId, organizationId, {
        collection: params.collection,
        format: params.format,
        content: params.content,
        on_conflict: params.on_conflict,
      });
      if ('error' in result) return errorResponse(result.error as string);
      return summarizedWriteResponse(result, collectionUrl);
    }
  );

  server.registerTool(
    "hutch_update_collection",
    {
      description: "Update a collection's name, description, unique_key (for upsert dedup), or published flag. Example: use when the user wants to publish a collection or set a dedup key.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        name: z.string().optional().describe("New collection name"),
        description: z.string().optional().describe("Collection description"),
        unique_key: z.array(z.string()).optional().describe("Fields that form the unique key for upsert (e.g. [\"url\"] or [\"email\", \"date\"])"),
        published: z.boolean().optional().describe("Whether the collection is publicly viewable"),
      },
      // destructiveHint: true because `published: true` exposes the collection to the public web.
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const { slug, ...updates } = params;
      const result = await collectionService.updateCollection(slug, userId, updates);
      if ('error' in result) return errorResponse(result.error!);
      return jsonResponse({ ...result.collection, url: collectionUrl(slug) });
    }
  );

  server.registerTool(
    "hutch_delete_collection",
    {
      description: "Permanently delete a collection and all of its records. Example: use when the user says 'drop the test collection' or 'delete bookmarks'.",
      inputSchema: { slug: z.string().describe("Collection slug to delete") },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.deleteCollection(slug, userId);
      if ('error' in result) return errorResponse(result.error!);
      return textResponse(`Collection '${slug}' deleted.`);
    }
  );

  server.registerTool(
    "hutch_update_record",
    {
      description: "Replace one record's data by ID (full overwrite, not a partial merge). Example: use when the user wants to fix a typo or change a value in a saved record.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        record_id: z.number().describe("Record ID to update"),
        data: z.record(z.string(), z.unknown()).describe("New data for the record (replaces existing data)"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, record_id, data }) => {
      const result = await recordService.updateRecord(slug, userId, record_id, data as Record<string, unknown>);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result.record, url: collectionUrl(slug) });
    }
  );

  server.registerTool(
    "hutch_transform_records",
    {
      description: "Bulk rename, remove, or set fields across records in a collection (optionally filtered). Example: use when the user says 'rename status to state across all tasks' or 'clear the legacy field'.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        rename_fields: z.record(z.string(), z.string()).optional().describe("Rename fields: {old_name: new_name} (e.g. {\"status\": \"state\"})"),
        remove_fields: z.array(z.string()).optional().describe("Fields to remove from all records (e.g. [\"legacy_id\"])"),
        set_field: z.object({
          field: z.string().describe("Field name to set"),
          value: z.unknown().describe("New value"),
          filter: z.record(z.string(), z.unknown()).optional().describe("Only update records matching this filter (e.g. {\"status\": \"active\"})"),
        }).optional().describe("Set a field value, optionally on filtered records"),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ slug, rename_fields, remove_fields, set_field }) => {
      const result = await recordService.transformRecords(slug, userId, {
        rename_fields: rename_fields as Record<string, string> | undefined,
        remove_fields,
        set_field: set_field as { field: string; value: unknown; filter?: Record<string, unknown> } | undefined,
      });
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result, url: collectionUrl(slug) });
    }
  );

  server.registerTool(
    "hutch_delete_record",
    {
      description: "Soft-delete one record by ID. Example: use when the user says 'remove this bookmark' or 'drop record 42'.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        record_id: z.number().describe("Record ID to delete"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, record_id }) => {
      const result = await recordService.deleteRecord(slug, userId, record_id);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      const json = JSON.stringify({ deleted: true, record_id, url: collectionUrl(slug) }, null, 2);
      return textResponse(`Record ${record_id} deleted.\n\n${json}`);
    }
  );

  server.registerTool(
    "hutch_infer_schema",
    {
      description: "Analyze existing records to detect field types and save the inferred schema on the collection. Example: use when the user has stored records and asks Hutch to figure out the shape.",
      inputSchema: { slug: z.string().describe("Collection slug") },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.inferCollectionSchema(slug, userId);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result, url: collectionUrl(slug) });
    }
  );

  server.registerTool(
    "hutch_update_schema",
    {
      description: "Set a field's type, options, position, or visibility on a collection's schema. Example: use when the user says 'make status a select with options todo/done'.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        field: z.string().describe("Field name to update"),
        type: z.enum(["text","number","boolean","date","url","email","image_url","select","multiselect","json","file"]).optional(),
        options: z.array(z.string()).optional().describe("Options for select/multiselect fields (e.g. [\"todo\", \"in-progress\", \"done\"])"),
        position: z.number().optional(),
        hidden: z.boolean().optional(),
      },
      // destructiveHint: true — schema rewrites change how subsequent queries behave.
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, field, type, options, position, hidden }) => {
      const result = await collectionService.updateFieldDefinition(slug, userId, field, { type, options, position, hidden });
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result, url: collectionUrl(slug) });
    }
  );

  server.registerTool(
    "hutch_set_record_status",
    {
      description: "Set one record's status to active, pending, flagged, or archived. Example: use when the user says 'archive this one' or 'flag for review'.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        record_id: z.number().describe("Record ID"),
        status: z.enum(["active","pending","flagged","archived"]).describe("New status"),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, record_id, status }) => {
      const result = await recordService.updateRecordStatus(slug, userId, record_id, status);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result, url: collectionUrl(slug) });
    }
  );

  server.registerTool(
    "hutch_create_view",
    {
      description: "Create a saved view on a collection (table, kanban, calendar, gallery, etc). Example: use when the user says 'show this as a kanban grouped by status'. For kanban, group_by is auto-inferred to the first select field if omitted.",
      inputSchema: {
        slug: z.string().describe("Collection slug"),
        type: z.enum(VIEW_TYPES).optional().default("table"),
        name: z.string().optional().describe("View name (defaults to the type label)"),
        group_by: z.string().optional().describe("Field name to group by (kanban only), e.g. \"status\". If omitted on kanban, the first select field is inferred."),
        config: z.record(z.string(), z.unknown()).optional().describe("View-type-specific settings (e.g. {\"dateField\": \"due_date\"} for calendar, {\"imageField\": \"cover\"} for gallery)"),
        filter: z.record(z.string(), z.unknown()).optional().describe("JSONB containment filter applied by the view (e.g. {\"status\": \"active\"})"),
        sort: z.string().optional().describe("Sort field, prefix with - for descending (e.g. \"-created_at\")"),
        columns: z.array(z.string()).optional().describe("Columns to display, in order (e.g. [\"title\", \"url\"])"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      let groupBy: string | undefined;
      if (params.type === "kanban") {
        if (params.group_by) {
          groupBy = params.group_by;
        } else {
          const coll = await collectionService.getCollection(params.slug, userId);
          if (!coll) return collectionNotFound(params.slug);
          const fields = (coll.schema as { fields?: { name: string; type?: string }[] } | null)?.fields ?? [];
          const selectField = fields.find((f) => f.type === "select");
          if (!selectField) {
            return errorResponse(
              "Cannot infer group_by: collection has no select-type field. Pass group_by explicitly, or first call hutch_update_schema to make a field of type 'select'."
            );
          }
          groupBy = selectField.name;
        }
      }

      const result = await createView(params.slug, userId, {
        type: params.type,
        config: params.config as Record<string, unknown> | undefined,
        filter: params.filter as Record<string, unknown> | undefined,
        sort: params.sort,
        columns: params.columns,
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(groupBy !== undefined ? { groupBy } : {}),
      });
      if (!result) return collectionNotFound(params.slug);
      if ("error" in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result.view, url: collectionUrl(params.slug) });
    }
  );

  server.registerTool(
    "hutch_put_file",
    {
      description: "Store a file at a path inside a collection (upserts on path; the collection auto-creates if new). Small UTF-8 text is kept inline; binary or large content (use content_base64) goes to blob storage. Max 4MB. Example: use when the user says 'save this file' or the agent wants to persist a prompt, config, or image.",
      inputSchema: {
        collection: z.string().describe("Collection name or slug (auto-created with upsert-on-path if new)"),
        path: z.string().describe("Relative file path within the collection (e.g. 'prompts/reviewer.md'). No '..' segments."),
        content: z.string().optional().describe("UTF-8 text content (use this OR content_base64, not both)"),
        content_base64: z.string().optional().describe("Base64-encoded bytes for binary content"),
        mime_type: z.string().optional().describe("MIME type (e.g. 'text/markdown', 'image/png'). Text-like types stay inline when small."),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await fileService.putFile(userId, organizationId, {
        collection: params.collection,
        path: params.path,
        content: params.content,
        contentBase64: params.content_base64,
        mimeType: params.mime_type,
      });
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_get_file",
    {
      description: "Read a file from a collection by path. Inline text files return their content; blob files return a time-limited download_url instead. Example: use when the user asks for a stored file's contents.",
      inputSchema: {
        collection: z.string().describe("Collection slug"),
        path: z.string().describe("File path within the collection (e.g. \"prompts/reviewer.md\")"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ collection, path }) => {
      const result = await fileService.getFile(collection, userId, path);
      if (!result) return collectionNotFound(collection);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse(result);
    }
  );

  server.registerTool(
    "hutch_list_files",
    {
      description: "List the files in a collection — path, filename, mime_type, size, and content_hash (no content). Example: use when the user asks 'what files are stored in agent-files?'.",
      inputSchema: {
        collection: z.string().describe("Collection slug"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ collection }) => {
      const result = await fileService.listFiles(collection, userId);
      if (!result) return collectionNotFound(collection);
      return jsonResponse(result);
    }
  );

  return server;
}
