import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { DrizzleQueryError } from "drizzle-orm";
import { z } from "zod";
import * as collectionService from "@/lib/services/collections";
import * as recordService from "@/lib/services/records";
import { createView } from "@/lib/services/views";
import { VIEW_TYPES } from "@/lib/views/types";
import { FILTER_OPERATORS, MAX_GROUP_BY_KEYS } from "@/lib/db/queries";
import { MCP_MAX_REQUEST_BODY_LABEL } from "@/lib/constants";

/**
 * hutch_query_records description: nested arrays, automatic indexing and the
 * indexed/plan/reason fields.
 */
const QUERY_DESCRIPTION = "Fetch records from a collection with filter, search, sort, group_by, aggregate, time_bucket, and pagination. filter, sort, group_by and aggregate accept dotted paths of any depth: \"a.b.c\" reaches into nested objects; \"votes.category_id\" reaches into an array of objects (matches when some element matches; several conditions on the same array must hold for the same element) and may go deeper (\"votes.points.veterans\"). Hutch indexes as data arrives: scalar fields present in most records, top-level or nested up to two objects deep (\"totals.veterans.points\"), become indexed columns once a collection holds many records or a queryable array (at most 16 per collection; an object with more keys than that, such as one keyed by category, is treated as a map and its entries are not indexed), and an array of objects becomes queryable once it holds many elements, with the first key below an element indexed. Anything not indexed is evaluated over the stored documents with the same result. Aggregating over an array (group_by or aggregate on one of its paths) returns one row per parent record and group value, with the parent attached as `record` holding its top-level scalar values (or the `fields` you list; pass record: false to omit it). group_by takes one key or an array of up to 3 keys (parent fields and/or paths of one array); result columns are named by the key. With group_by/aggregate, sort takes an aggregate alias or a group_by key and limit applies after sorting, so sort: \"-points\" with limit: 10 returns the top 10 groups; aggregate responses include total (the number of groups before limit). An unknown sort field, or one no record in the collection has, is an error — never silently ignored. Every response includes total, `indexed` (whether an index served a filter, search or sort you wrote), `plan`, and a `reason` when not indexed. Example: use when the user asks 'show me bookmarks tagged work from last week'.";

/** Added to the store/import descriptions. */
const NESTED_DOCUMENTS_NOTE = "Records can be nested documents: arrays of objects (e.g. an order with its line items) are fine and are made queryable automatically once there are many of them. ";

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

/**
 * Database-layer failures whose messages leak driver internals (SQL text,
 * bound params) and must never reach the MCP client verbatim.
 *
 * drizzle-orm 0.45 throws DrizzleQueryError with message
 * "Failed query: <sql>\nparams: <params>". Note the class never assigns
 * `this.name`, so at runtime `err.name` is plain "Error" — the instanceof
 * and message checks are the ones that actually fire; the name check is
 * kept for errors crossing realm/bundle boundaries where instanceof fails.
 */
function isDatabaseError(err: unknown): boolean {
  if (err instanceof DrizzleQueryError) return true;
  if (!(err instanceof Error)) return false;
  return err.name === "DrizzleQueryError" || /^Failed query/i.test(err.message);
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

  /**
   * Error-hygiene chokepoint for every tool registration. If a handler
   * throws a database-layer error, the MCP SDK would otherwise stringify
   * it into the tool output — leaking raw SQL and bound params to the
   * client. Catch those here: log the real error server-side, return a
   * generic isError response. Every OTHER throw is rethrown unchanged so
   * intentional validation errors (e.g. "Unsupported filter operator …"
   * from the query engine) still reach the client verbatim via the SDK.
   */
  const registerTool = ((
    name: string,
    config: Record<string, unknown>,
    handler: (...a: unknown[]) => unknown
  ) => {
    const wrapped = async (...args: unknown[]) => {
      try {
        return await (handler as (...a: unknown[]) => Promise<McpToolResponse>)(...args);
      } catch (err) {
        if (isDatabaseError(err)) {
          console.error(`[mcp] ${name} database error:`, err);
          return errorResponse(
            `${name} failed while accessing the database. Try again or adjust the inputs.`
          );
        }
        throw err;
      }
    };
    // The connectors-directory review reads title and readOnlyHint from
    // annotations and flags them as missing otherwise, so mirror the
    // top-level title and make the spec-default readOnlyHint explicit.
    // Explicit per-tool annotations win via spread order.
    const cfg = config as { title?: string; annotations?: ToolAnnotations };
    const annotations: ToolAnnotations = {
      ...(cfg.title !== undefined && { title: cfg.title }),
      readOnlyHint: false,
      ...cfg.annotations,
    };
    const enriched = { ...cfg, annotations };
    return (server.registerTool as (n: string, c: unknown, h: unknown) => unknown)(name, enriched, wrapped);
  }) as McpServer["registerTool"];

  registerTool(
    "hutch_list_collections",
    {
      title: "List Collections",
      description: "List every collection the user has stored, with id, name, slug, description, unique_key, and record count. Use hutch_describe_collection for a collection's fields and types. Example: use when the user asks 'what data do I have in Hutch?'.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const collections = await collectionService.listCollections(userId);
      // Summary only — omitting each collection's full schema keeps this
      // response small on accounts with many collections; per-collection
      // detail lives in hutch_describe_collection / hutch_get_collection.
      return jsonResponse(
        collections.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          description: c.description,
          uniqueKey: c.uniqueKey,
          published: c.published,
          recordCount: c.recordCount,
          lastRecordAt: c.lastRecordAt,
          updatedAt: c.updatedAt,
        }))
      );
    }
  );

  registerTool(
    "hutch_get_collection",
    {
      title: "Get Collection",
      description: "Get one collection's metadata, settings, and record count by slug. Example: use when the user asks 'how big is my bookmarks collection?'.",
      inputSchema: z.object({ slug: z.string().describe("Collection slug") }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.getCollection(slug, userId);
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  registerTool(
    "hutch_describe_collection",
    {
      title: "Describe Collection",
      description: "Describe a collection's field names, types, and sample values, plus its storage: which fields (top-level or nested object paths) are projected into indexed columns and which nested arrays of objects have been made queryable (unwound), each with the reason. Example: call before hutch_query_records when you don't know what fields exist or whether to filter vs search.",
      inputSchema: z.object({ slug: z.string().describe("Collection slug") }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.describeCollection(slug, userId);
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  registerTool(
    "hutch_store_records",
    {
      title: "Store Records",
      description: `Save one or many records to a collection (auto-creates the collection if new). ${NESTED_DOCUMENTS_NOTE}The request body is limited to ${MCP_MAX_REQUEST_BODY_LABEL}; split larger loads into several calls and pass return: "summary" to skip echoing the stored records. Example: use when the user says 'save this' or has just produced structured output worth keeping for later.`,
      inputSchema: z.object({
        collection: z.string().describe("Collection name (e.g. 'bookmarks', 'notes', 'research'). Created automatically if new."),
        data: z.record(z.string(), z.unknown()).optional().describe("Single record as a JSON object (e.g. {\"title\": \"My note\", \"tags\": [\"work\"]}). Use this OR records, not both."),
        records: z.array(z.record(z.string(), z.unknown())).optional().describe("Array of record objects for storing multiple items at once (e.g. [{\"title\": \"A\"}, {\"title\": \"B\"}])"),
        on_conflict: z.enum(["replace", "merge", "skip", "error"]).optional().describe("What to do if a record with the same unique key exists. Default: replace"),
        return: z.enum(["records", "summary"]).optional().describe("\"records\" (default) echoes each stored record; \"summary\" returns only counts and the summary line — use it for bulk loads."),
      }),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.createRecords(userId, organizationId, {
        collection: params.collection,
        data: params.data as Record<string, unknown> | undefined,
        records: params.records as Record<string, unknown>[] | undefined,
        on_conflict: params.on_conflict,
        return: params.return,
      });
      if ('error' in result) {
        return errorResponse(result.error as string);
      }
      return summarizedWriteResponse(result, collectionUrl);
    }
  );

  registerTool(
    "hutch_query_records",
    {
      title: "Query Records",
      description: QUERY_DESCRIPTION,
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        filter: z.record(z.string(), z.unknown()).optional().describe(FILTER_DESCRIPTION),
        search: z.string().optional().describe("Full-text search query. Use for free-text across string fields."),
        sort: z.string().optional().describe("Sort field, prefix with - for descending: a field, a dotted object path (\"-totals.veterans.points\"), id, created_at, updated_at, or — with group_by/aggregate — an aggregate alias or group_by key (\"-points\"). Unknown fields are an error."),
        fields: z.array(z.string()).optional().describe("Projection: top-level data keys to include in each returned record's data (e.g. [\"title\", \"url\"]), also applied to the `record` embedded in nested aggregates. System fields id/status/created_at/updated_at are always returned."),
        group_by: z.union([z.string(), z.array(z.string()).max(MAX_GROUP_BY_KEYS)]).optional().describe("Field(s) to group by for aggregation: one key (e.g. \"status\") or up to 3 (e.g. [\"votes.chamber\", \"votes.vote\"]); dotted paths into objects or one array allowed"),
        record: z.boolean().optional().describe("Aggregates over a nested array only: false omits the embedded parent record from each row"),
        aggregate: z.record(z.string(), z.unknown()).optional().describe("Aggregation spec mapping result alias to \"count\" or {op: field} where op is min/max/distinct/sum/avg (e.g. {\"total\": \"count\", \"revenue\": {\"sum\": \"amount\"}}). sum/avg only aggregate numeric values and return null when a field has none. min/max compare numerically when a field has numeric values (ignoring non-numeric ones), otherwise as text (works for ISO dates), so with group_by one alias can be a number in some groups and a string in others."),
        time_bucket: z.string().optional().describe("Time bucket (hour, day, week, month, year)"),
        created_after: z.string().optional().describe("Filter records created after this ISO date (e.g. \"2026-07-01\" or \"2026-07-01T12:00:00Z\")"),
        created_before: z.string().optional().describe("Filter records created before this ISO date (e.g. \"2026-07-18\")"),
        limit: z.number().optional().describe("Max records to return (default 50, max 1000)"),
        offset: z.number().optional().describe("Offset for pagination"),
      }),
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
        record: (params as { record?: boolean }).record,
      });
      if (!result) return collectionNotFound(params.slug);
      return jsonResponse(result);
    }
  );

  registerTool(
    "hutch_search",
    {
      title: "Search Records",
      description: "Full-text search across every collection the user has access to. Example: use when the user is looking for something but doesn't know which collection holds it.",
      inputSchema: z.object({
        search: z.string().describe("What to search for — matches against all fields in all collections"),
        limit: z.number().optional().describe("Max results per collection (default 10, max 50)"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.searchGlobal(userId, params.search, params.limit);
      return jsonResponse(result);
    }
  );

  registerTool(
    "hutch_collection_stats",
    {
      title: "Collection Stats",
      description: "Get statistics for one collection: record_count, counts by status, first/last created_at and updated_at, approximate storage bytes, and per-field fill rates (for each top-level key: how many records have it and what percent, most common first, capped at 50 keys). Fill rates are exact counts over all records (hutch_describe_collection's frequency is sampled). Example: use before a bulk cleanup, or when the user asks 'how complete is my contacts data?' or 'how big is this collection really?'.",
      inputSchema: z.object({ slug: z.string().describe("Collection slug") }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.getCollectionStats(slug, userId);
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  registerTool(
    "hutch_export_records",
    {
      title: "Export Records",
      description: "Export a collection's records as JSON or CSV text. Accepts the same filter/search/sort/fields params as hutch_query_records, plus limit (default 1000, max 10000). Returns count, total, a truncated flag, and the serialized content. CSV columns are id, created_at, updated_at, then the union of top-level record fields; nested objects/arrays are JSON-stringified into their cell. CSV cells are written verbatim (no spreadsheet formula-escaping) so exports round-trip. Example: use when the user says 'give me my contacts as a CSV' or when handing data to a tool that wants a flat file.",
      inputSchema: z.object({
        collection: z.string().describe("Collection slug"),
        format: z.enum(["json", "csv"]).optional().describe("Output format. Default: json"),
        filter: z.record(z.string(), z.unknown()).optional().describe(FILTER_DESCRIPTION),
        search: z.string().optional().describe("Full-text search query applied before export"),
        sort: z.string().optional().describe("Sort field, prefix with - for descending: a top-level field, a dotted object path (\"-totals.veterans.points\"), id, created_at or updated_at (e.g. \"-created_at\"). Unknown fields are an error."),
        fields: z.array(z.string()).optional().describe("Top-level data keys to include (CSV data columns / JSON data keys). Omit for all fields."),
        limit: z.number().optional().describe("Max records to export (default 1000, max 10000). Check the truncated flag in the response."),
      }),
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

  registerTool(
    "hutch_import_records",
    {
      title: "Import Records",
      description: `Import records into a collection from CSV or JSON text (auto-creates the collection if new; honors unique_key and on_conflict exactly like hutch_store_records). ${NESTED_DOCUMENTS_NOTE.replace("Records can", "JSON records can")}The request body is limited to ${MCP_MAX_REQUEST_BODY_LABEL} (content up to 10 MB). CSV requires a header row; numeric strings become numbers, true/false become booleans, empty cells are omitted, JSON-looking cells ({...} or [...]) are parsed, and id/created_at/updated_at columns are ignored — so hutch_export_records output round-trips cleanly. Example: use when the user pastes a spreadsheet export and says 'load this into Hutch'. For records you already hold as JSON objects, hutch_store_records is the more direct path.`,
      inputSchema: z.object({
        collection: z.string().describe("Collection name or slug (created automatically if new)"),
        format: z.enum(["csv", "json"]).optional().describe("Content format. Default: csv"),
        content: z.string().max(10 * 1024 * 1024).describe("Raw CSV text (header row required) or a JSON array of objects. Max 10MB."),
        on_conflict: z.enum(["replace", "merge", "skip", "error"]).optional().describe("What to do when a record matches an existing unique key. Default: replace"),
        return: z.enum(["records", "summary"]).optional().describe("\"summary\" (default) returns counts only; \"records\" also echoes each stored record."),
      }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.importRecords(userId, organizationId, {
        collection: params.collection,
        format: params.format,
        content: params.content,
        on_conflict: params.on_conflict,
        return: params.return,
      });
      if ('error' in result) return errorResponse(result.error as string);
      return summarizedWriteResponse(result, collectionUrl);
    }
  );

  registerTool(
    "hutch_update_collection",
    {
      title: "Update Collection",
      description: "Update a collection's name, description, unique_key (for upsert dedup), or published flag. Example: use when the user wants to publish a collection or set a dedup key.",
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        name: z.string().optional().describe("New collection name"),
        description: z.string().optional().describe("Collection description"),
        unique_key: z.array(z.string()).optional().describe("Fields that form the unique key for upsert (e.g. [\"url\"] or [\"email\", \"date\"])"),
        published: z.boolean().optional().describe("Whether the collection is publicly viewable"),
      }),
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

  registerTool(
    "hutch_delete_collection",
    {
      title: "Delete Collection",
      description: "Permanently delete a collection and all of its records. Example: use when the user says 'drop the test collection' or 'delete bookmarks'.",
      inputSchema: z.object({ slug: z.string().describe("Collection slug to delete") }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.deleteCollection(slug, userId);
      if ('error' in result) return errorResponse(result.error!);
      return textResponse(`Collection '${slug}' deleted.`);
    }
  );

  registerTool(
    "hutch_update_record",
    {
      title: "Update Record",
      description: "Replace one record's data by ID (full overwrite, not a partial merge). Example: use when the user wants to fix a typo or change a value in a saved record.",
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        record_id: z.number().describe("Record ID to update"),
        data: z.record(z.string(), z.unknown()).describe("New data for the record (replaces existing data)"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, record_id, data }) => {
      const result = await recordService.updateRecord(slug, userId, record_id, data as Record<string, unknown>);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result.record, url: collectionUrl(slug) });
    }
  );

  registerTool(
    "hutch_transform_records",
    {
      title: "Transform Records",
      description: "Bulk rename, remove, or set fields across records in a collection (optionally filtered). Example: use when the user says 'rename status to state across all tasks' or 'clear the legacy field'.",
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        rename_fields: z.record(z.string(), z.string()).optional().describe("Rename fields: {old_name: new_name} (e.g. {\"status\": \"state\"})"),
        remove_fields: z.array(z.string()).optional().describe("Fields to remove from all records (e.g. [\"legacy_id\"])"),
        set_field: z.object({
          field: z.string().describe("Field name to set"),
          value: z.unknown().describe("New value"),
          filter: z.record(z.string(), z.unknown()).optional().describe("Only update records matching this filter (e.g. {\"status\": \"active\"})"),
        }).optional().describe("Set a field value, optionally on filtered records"),
      }),
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

  registerTool(
    "hutch_delete_record",
    {
      title: "Delete Record",
      description: "Soft-delete one record by ID. Example: use when the user says 'remove this bookmark' or 'drop record 42'.",
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        record_id: z.number().describe("Record ID to delete"),
      }),
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

  registerTool(
    "hutch_infer_schema",
    {
      title: "Infer Schema",
      description: "Analyze existing records to detect field types and save the inferred schema on the collection. Example: use when the user has stored records and asks Hutch to figure out the shape.",
      inputSchema: z.object({ slug: z.string().describe("Collection slug") }),
      // Saves the inferred schema over any manually-set field types — destructive
      // by the same logic as hutch_update_schema.
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.inferCollectionSchema(slug, userId);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result, url: collectionUrl(slug) });
    }
  );

  registerTool(
    "hutch_update_schema",
    {
      title: "Update Schema",
      description: "Set a field's type, options, position, or visibility on a collection's schema. Example: use when the user says 'make status a select with options todo/done'.",
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        field: z.string().describe("Field name to update"),
        type: z.enum(["text","number","boolean","date","url","email","image_url","select","multiselect","json","file"]).optional(),
        options: z.array(z.string()).optional().describe("Options for select/multiselect fields (e.g. [\"todo\", \"in-progress\", \"done\"])"),
        position: z.number().optional(),
        hidden: z.boolean().optional(),
      }),
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

  registerTool(
    "hutch_set_record_status",
    {
      title: "Set Record Status",
      description: "Set one record's status to active, pending, flagged, or archived. Example: use when the user says 'archive this one' or 'flag for review'.",
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        record_id: z.number().describe("Record ID"),
        status: z.enum(["active","pending","flagged","archived"]).describe("New status"),
      }),
      // destructiveHint: true — overwrites an existing record's status.
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, record_id, status }) => {
      const result = await recordService.updateRecordStatus(slug, userId, record_id, status);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result, url: collectionUrl(slug) });
    }
  );

  registerTool(
    "hutch_create_view",
    {
      title: "Create View",
      description: "Create a saved view on a collection (table, kanban, calendar, gallery, etc). Example: use when the user says 'show this as a kanban grouped by status'. For kanban, group_by is auto-inferred to the first select field if omitted.",
      inputSchema: z.object({
        slug: z.string().describe("Collection slug"),
        type: z.enum(VIEW_TYPES).optional().default("table"),
        name: z.string().optional().describe("View name (defaults to the type label)"),
        group_by: z.string().optional().describe("Field name to group by (kanban only), e.g. \"status\". If omitted on kanban, the first select field is inferred."),
        config: z.record(z.string(), z.unknown()).optional().describe("View-type-specific settings (e.g. {\"dateField\": \"due_date\"} for calendar, {\"imageField\": \"cover\"} for gallery)"),
        filter: z.record(z.string(), z.unknown()).optional().describe("JSONB containment filter applied by the view (e.g. {\"status\": \"active\"})"),
        sort: z.string().optional().describe("Sort field, prefix with - for descending (e.g. \"-created_at\")"),
        columns: z.array(z.string()).optional().describe("Columns to display, in order (e.g. [\"title\", \"url\"])"),
      }),
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

  return server;
}
