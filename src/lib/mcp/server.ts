import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as collectionService from "@/lib/services/collections";
import * as recordService from "@/lib/services/records";
import { createView } from "@/lib/services/views";
import { VIEW_TYPES } from "@/lib/views/types";
import { FILTER_OPERATORS, MAX_GROUP_BY_KEYS } from "@/lib/db/queries";
import { MCP_MAX_REQUEST_BODY_BYTES, MCP_MAX_REQUEST_BODY_LABEL } from "@/lib/constants";
import { DESCRIBE_FIELDS_PAGE } from "@/lib/describe";
import { classifyDbError, describeDbError, isDatabaseError } from "@/lib/db/errors";

/**
 * hutch_query_records description: nested arrays, automatic indexing and the
 * indexed/plan/reason fields.
 */
const QUERY_DESCRIPTION = `Fetch records from a collection with filter, search, sort, group_by, aggregate, time_bucket, and pagination. filter, sort, group_by and aggregate accept dotted paths of any depth: "a.b.c" reaches into nested objects; "votes.category_id" reaches into an array of objects (matches when some element matches; several conditions on the same array must hold for the same element) and may go deeper ("votes.points.veterans"). A field holding an array of scalars (tags) matches when some element matches (see filter). Hutch indexes as data arrives: scalar fields present in most records, top-level or nested up to two objects deep ("totals.veterans.points"), become indexed columns once a collection holds many records or a queryable array (at most 16 per collection; long text is never indexed; an object with more keys than that, such as one keyed by category, is treated as a map and its entries are not indexed), and an array of objects becomes queryable once it holds many elements: every scalar key present in most of its elements (90%) with one consistent type gets its own indexed column, up to 16 (keys nested deeper inside an element, such as "answers.author.user_id", get none). Separately, a GIN index on the documents serves equality on any field or path — including elements of an array of scalars ({"tags": "hiking"}) and keys inside arrays of objects — plus containment and $in, but not ranges. hutch_describe_collection lists every index under storage.indexes. Anything not indexed is evaluated over the stored documents with the same result. group_by takes one key or an array of up to ${MAX_GROUP_BY_KEYS} keys; result columns are named by the key and keep the value's JSON type (numbers come back as numbers). Grouping by an array of scalars groups per element: group_by: "tags" with aggregate {"n": "count"} counts records per tag, and other aggregates (sum of score) add each record's value to every tag it holds. Grouping by a field holding an array of objects ("items") likewise groups per element, keyed by the whole element; an empty array groups as null. Grouping or aggregating on a path into an array of objects ("votes.vote") runs over the elements and totals across records: one row per group value, and parent fields may be grouped or aggregated alongside (a parent's value then counts once per element). A filter condition on a path into the same array also restricts which elements are aggregated: {"filter": {"votes.category": "veterans"}, "group_by": "name", "aggregate": {"points": {"sum": "votes.points"}, "n": "count"}} sums and counts only the veterans votes of each member. "count" counts every row in the group (with an array path in group_by/aggregate, every element); {"count": "votes.points.veterans"} counts only the rows or elements where that path has a non-null value. "first" returns one value per group (the first non-null in storage order), for carrying a column such as a name alongside the group without grouping by it. Pass per_record: true for one row per record and group value instead, with the record attached as \`record\` (its top-level scalars, or the \`fields\` you list; record: false omits it). With group_by/aggregate, sort takes aggregate aliases and group_by keys and limit applies after sorting, so sort: "-points" with limit: 10 returns the top 10 groups; aggregate responses include total (the number of groups before limit). sort takes up to 3 keys, as "-points,name" or ["-points", "name"], the first deciding first. An unknown sort field, or one no record in the collection has, is an error — never silently ignored. Response shape: a records query returns \`records\` (each with id, data, status, created_at, updated_at); a group_by/aggregate query returns \`results\`, one object per group keyed by the group_by keys and aggregate aliases. Both include total (matching records, or groups), has_more and next_offset for paging with offset; limit: 0 means count only (total, no records or groups, has_more false). fields takes dotted paths into arrays of objects: ["title", "answers.answer_id", "answers.score"] returns answers as [{answer_id, score}, ...]. array_sort and array_limit order and cut an array inside each returned record (applied before fields): {"array_sort": {"answers": "-score,creation_date"}, "array_limit": {"answers": 10}} returns the 10 best answers; a record whose array was cut carries array_totals with its full length ({"answers": 22}). sum and avg count booleans as 1 (true) and 0 (false), so sum of a flag is how many are true. In aggregate sorts, groups whose key or sorted value is null come last in both directions (as records do), and offset pages through all groups. Every response includes total, \`indexed\` (whether an index served a filter, search or sort you wrote), \`plan\`, and a \`reason\` when not indexed. Example: use when the user asks 'show me bookmarks tagged work from last week'.`;

/** Added to the store/import descriptions. */
const NESTED_DOCUMENTS_NOTE = "Records can be nested documents: arrays of objects (e.g. an order with its line items) are fine and are made queryable automatically once there are many of them. ";

const SERVER_INSTRUCTIONS = `Hutch Core stores structured data for a single AI agent user. Records are arbitrary JSON, grouped into collections.

Workflow for answering questions about stored data:
1. hutch_list_collections — see what exists
2. hutch_describe_collection — learn its fields and types
3. hutch_query_records — fetch with filters/search

Collections auto-create on the first hutch_store_records. No setup step. Every tool that takes a collection accepts its slug or its exact name (as hutch_list_collections shows them).

Use filter for exact/numeric/enum matches, search for free-text across string fields, or combine both. Run hutch_describe_collection first when you don't know a field's type. Filters also accept Mongo-style operator objects per field: $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $contains (e.g. {"price": {"$gte": 10}}), and $or / $and at the top level (e.g. {"$or": [{"status": "open"}, {"price": {"$lt": 5}}]}).

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
  "On a field holding an array of scalars (e.g. tags), a plain value, $in, $gt/$gte/$lt/$lte and $contains match when some element matches " +
  "({\"tags\": \"hiking\"}, {\"tags\": {\"$in\": [\"hiking\", \"snow\"]}}); $ne/$nin match when no element does; an array value " +
  "({\"tags\": [\"hiking\", \"snow\"]}) needs every listed element. " +
  "Combine conditions with $or / $and at the top of the filter, each taking an array of filters, nestable: " +
  "{\"$or\": [{\"status\": \"open\"}, {\"score\": {\"$gt\": 10}}]}. A $or/$and branch selects records; with group_by over an array of objects it does not restrict which elements are aggregated (a plain array-path condition does). " +
  "Any other top-level key starting with $ is an error. " +
  "Example: {\"price\": {\"$gte\": 10, \"$lt\": 100}, \"status\": {\"$in\": [\"active\", \"pending\"]}}";

// Field paging shared by hutch_describe_collection and hutch_get_collection.
const FIELDS_OFFSET_DESCRIPTION = `Skip this many fields (default 0): each call lists at most ${DESCRIBE_FIELDS_PAGE}; pass the response's fields_next_offset for the next page.`;
const FIELD_PREFIX_DESCRIPTION = "Only list fields whose name starts with this (case-sensitive), e.g. \"voltage\" for voltage_0, voltage_1, ...";

function textResponse(text: string): McpToolResponse {
  return { content: [{ type: "text", text }] };
}

function errorResponse(text: string): McpToolResponse {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Tool results are compact JSON: the reader is an agent, and indentation
 * made responses 2.2x larger (finding 7 of the stress test). Humans read
 * them through a client or `jq`.
 */
function jsonResponse(value: unknown): McpToolResponse {
  return textResponse(JSON.stringify(value));
}

/**
 * Shared by hutch_store_records and hutch_import_records: attach the
 * collection URL and lead with the human-readable summary when present.
 */
function summarizedWriteResponse(result: object, collectionUrl: (slug: string) => string): McpToolResponse {
  const slug = (result as { collection?: { slug?: string } }).collection?.slug;
  const enriched = slug ? { ...result, url: collectionUrl(slug) } : result;
  const json = JSON.stringify(enriched);
  const summary = (result as { summary?: string }).summary;
  return textResponse(summary ? `${summary}\n\n${json}` : json);
}

function collectionNotFound(slug: string): McpToolResponse {
  return errorResponse(
    `Collection '${slug}' not found (tools accept a collection's slug or its exact name). Call hutch_list_collections to see available names and slugs, or use hutch_store_records to create a new one by writing to it.`
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
  // Every slug argument also accepts the collection's exact name (services resolve it).
  const slugDescription = "Collection slug, or the collection's exact name (e.g. \"tags\")";

  /**
   * Error-hygiene chokepoint for every tool registration. If a handler
   * throws a database-layer error, the MCP SDK would otherwise stringify
   * it into the tool output — leaking raw SQL and bound params to the
   * client. Catch those here: log the real error server-side, return an
   * isError response that says what happened (a timeout, a value of the
   * wrong type, or a generic failure) without any driver text. Every OTHER throw is rethrown unchanged so
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
          // The collection as the caller named it (slug or exact name) — their own input, safe to echo.
          const params = (args[0] ?? {}) as { slug?: unknown; collection?: unknown };
          const collection = typeof params.slug === "string" ? params.slug
            : typeof params.collection === "string" ? params.collection : undefined;
          let timeoutHint: string | undefined;
          if (collection && classifyDbError(err) === "timeout") {
            try {
              timeoutHint = await collectionService.storageTimeoutHint(collection, userId);
            } catch {
              // The hint is best effort; the timeout message stands without it.
            }
          }
          return errorResponse(describeDbError(err, { tool: name, collection, timeoutHint }));
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
      description: `Get one collection's metadata, settings and record count, its saved schema (schema.fields: name, type, options; at most ${DESCRIBE_FIELDS_PAGE} per call, paged like hutch_describe_collection), and storage diagnostics: storage.projections (fields with indexed columns), storage.unwinds (arrays of objects made queryable), storage.pending_unwinds, and storage.failed_ddl (index builds that failed, so queries on those fields read every document). Example: use when the user asks 'how big is my bookmarks collection?', or when queries on a collection are slow or failing.`,
      inputSchema: z.object({
        slug: z.string().describe(slugDescription),
        fields_offset: z.number().int().min(0).optional().describe(FIELDS_OFFSET_DESCRIPTION),
        field_prefix: z.string().optional().describe(FIELD_PREFIX_DESCRIPTION),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, fields_offset, field_prefix }) => {
      const result = await collectionService.getCollection(slug, userId, { fields_offset, field_prefix });
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  registerTool(
    "hutch_describe_collection",
    {
      title: "Describe Collection",
      description: `Describe a collection's field names, types, and sample values, plus its storage: which fields (top-level or nested object paths) are projected into indexed columns, which nested arrays of objects have been made queryable (unwound), each with the reason, and storage.indexes — every index that can serve a query and what it serves, including the GIN index on the documents that serves equality on any field, array element or key inside an array of objects. Field types, frequency and sample values come from a sample of up to 500 records; distinctCount is an exact count of distinct values over all records (collections up to 20,000 records; scalar fields), and larger collections give distinctCountEstimate instead — Postgres's statistics estimate, for indexed fields only. Lists at most ${DESCRIBE_FIELDS_PAGE} fields per call, most common first, with fields_total, fields_omitted and fields_next_offset; page with fields_offset or find fields by name with field_prefix. A field whose records disagree on the type has conflict: true and typeCounts, and type follows the most common one; a projection with mixed: true serves equality but not ranges or sort. Example: call before hutch_query_records when you don't know what fields exist or whether to filter vs search.`,
      inputSchema: z.object({
        slug: z.string().describe(slugDescription),
        fields_offset: z.number().int().min(0).optional().describe(FIELDS_OFFSET_DESCRIPTION),
        field_prefix: z.string().optional().describe(FIELD_PREFIX_DESCRIPTION),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, fields_offset, field_prefix }) => {
      const result = await collectionService.describeCollection(slug, userId, { fields_offset, field_prefix });
      if (!result) return collectionNotFound(slug);
      return jsonResponse(result);
    }
  );

  registerTool(
    "hutch_store_records",
    {
      title: "Store Records",
      description: `Save one or many records to a collection (auto-creates the collection if new). ${NESTED_DOCUMENTS_NOTE}The request body is limited to ${MCP_MAX_REQUEST_BODY_LABEL}; split larger loads into several calls and pass return: "summary" to skip echoing the stored records. When a batch makes fields queryable or unwinds an array (building indexes over the existing records, which makes that write slower), the response says so in storage_note. Example: use when the user says 'save this' or has just produced structured output worth keeping for later.`,
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
        slug: z.string().describe(slugDescription),
        filter: z.record(z.string(), z.unknown()).optional().describe(FILTER_DESCRIPTION),
        search: z.string().optional().describe("Full-text search query. Use for free-text across string fields."),
        sort: z.union([z.string(), z.array(z.string()).max(3)]).optional().describe("Sort keys, each prefixed with - for descending: a field, a dotted object path (\"-totals.veterans.points\"), id, created_at, updated_at, or — with group_by/aggregate — an aggregate alias or group_by key (\"-points\"). Up to 3 keys as \"-points,name\" or [\"-points\", \"name\"]; later keys break ties. Index use is best effort with several keys. Unknown fields are an error."),
        fields: z.array(z.string()).optional().describe("Projection: which keys of each record's data to return — top-level keys (\"title\") or dotted paths into objects (\"totals.veterans\") and arrays of objects. A path into an array of objects returns the array with each element reduced to the listed keys, and sibling paths combine: [\"title\", \"answers.answer_id\", \"answers.score\"] returns title and answers as [{answer_id, score}, ...]. A field no record has is an error. Also applied to the `record` embedded in per_record aggregates. System fields id/status/created_at/updated_at are always returned."),
        array_sort: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("Records only: order an array of objects inside each returned record, keyed by the array's path, with sort keys below each element (- for descending, up to 3 keys, missing/null last; numbers numerically, strings in code-point order). Example: {\"answers\": \"-score,answer_id\"}. Combine with array_limit for 'top 10 answers': {\"array_sort\": {\"answers\": \"-score\"}, \"array_limit\": {\"answers\": 10}}."),
        array_limit: z.record(z.string(), z.number().int().min(0)).optional().describe("Records only: keep the first N elements of an array inside each returned record (after array_sort), keyed by the array's path, e.g. {\"votes\": 20}. Only the response is cut; filters still see every element."),
        group_by: z.union([z.string(), z.array(z.string()).max(MAX_GROUP_BY_KEYS)]).optional().describe(`Field(s) to group by for aggregation: one key (e.g. "status") or up to ${MAX_GROUP_BY_KEYS} (e.g. ["votes.chamber", "votes.vote"]); dotted paths into objects or one array allowed. To carry a column without grouping by it, use aggregate {"name": {"first": "name"}}.`),
        per_record: z.boolean().optional().describe("Aggregates over an array of objects only: true returns one row per record and group value (with parent_id and the record attached) instead of totals across records"),
        record: z.boolean().optional().describe("With per_record: false omits the embedded parent record from each row"),
        aggregate: z.record(z.string(), z.unknown()).optional().describe("Aggregation spec: an object mapping each result alias to \"count\" or to one {op: field}, op one of count/min/max/distinct/sum/avg/first. Example: {\"rows\": \"count\", \"voters\": {\"count\": \"votes.bill_id\"}, \"points\": {\"sum\": \"votes.points.veterans\"}, \"name\": {\"first\": \"name\"}} returns columns rows, voters, points and name for each group. \"count\" is the number of rows in the group (elements, when grouping over an array of objects); {\"count\": field} counts only those with a non-null value at field; first is one value from the group (the first non-null in storage order), for pass-through columns. sum/avg add numbers and count booleans as 1 (true) and 0 (false), so sum of a boolean is how many are true and avg the share; over a field whose values are only strings, arrays or objects they return an error naming the type (a warning when only some groups are affected). min/max compare numbers numerically, then booleans (false < true), then text (works for ISO dates), so with group_by one alias can be a number in some groups and a string in others."),
        time_bucket: z.string().optional().describe("Time bucket (hour, day, week, month, year)"),
        created_after: z.string().optional().describe("Filter records created after this ISO date (e.g. \"2026-07-01\" or \"2026-07-01T12:00:00Z\")"),
        created_before: z.string().optional().describe("Filter records created before this ISO date (e.g. \"2026-07-18\")"),
        limit: z.number().optional().describe("Max records (or groups, with group_by/aggregate) to return (default 50, max 1000). limit: 0 only counts: the response has total and no records — the number of matching records, or of groups for an aggregate."),
        offset: z.number().optional().describe("Offset for pagination, for records and for aggregate groups alike: follow next_offset while has_more is true."),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const result = await recordService.queryRecords(params.slug, userId, {
        filter: params.filter as Record<string, unknown> | undefined,
        search: params.search,
        sort: params.sort,
        fields: params.fields,
        arraySort: params.array_sort,
        arrayLimit: params.array_limit,
        groupBy: params.group_by,
        aggregate: params.aggregate as Record<string, string | Record<string, string>> | undefined,
        timeBucket: params.time_bucket,
        createdAfter: params.created_after,
        createdBefore: params.created_before,
        limit: params.limit,
        offset: params.offset,
        record: params.record,
        perRecord: params.per_record,
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
        limit: z.number().optional().describe("Max results in total across all collections (default 10, max 50), most relevant first, then newest; results are grouped by collection and each record carries its collection slug"),
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
      inputSchema: z.object({ slug: z.string().describe(slugDescription) }),
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
        collection: z.string().describe(slugDescription),
        format: z.enum(["json", "csv"]).optional().describe("Output format. Default: json"),
        filter: z.record(z.string(), z.unknown()).optional().describe(FILTER_DESCRIPTION),
        search: z.string().optional().describe("Full-text search query applied before export"),
        sort: z.union([z.string(), z.array(z.string()).max(3)]).optional().describe("Sort keys, each prefixed with - for descending: a top-level field, a dotted object path (\"-totals.veterans.points\"), id, created_at or updated_at; up to 3 as \"-points,name\" or an array. Unknown fields are an error."),
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
      description: `Import records into a collection from CSV or JSON text (auto-creates the collection if new; honors unique_key and on_conflict exactly like hutch_store_records). ${NESTED_DOCUMENTS_NOTE.replace("Records can", "JSON records can")}The request body is limited to ${MCP_MAX_REQUEST_BODY_LABEL} (content up to ${MCP_MAX_REQUEST_BODY_BYTES < 10 * 1024 * 1024 ? "a little less than that" : "10 MB"}). CSV requires a header row; numeric strings become numbers, true/false become booleans, empty cells are omitted, JSON-looking cells ({...} or [...]) are parsed, and id/created_at/updated_at columns are ignored — so hutch_export_records output round-trips cleanly. Example: use when the user pastes a spreadsheet export and says 'load this into Hutch'. For records you already hold as JSON objects, hutch_store_records is the more direct path.`,
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
        slug: z.string().describe(slugDescription),
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
      return jsonResponse({ ...result.collection, url: collectionUrl((result.collection as { slug?: string }).slug ?? slug) });
    }
  );

  registerTool(
    "hutch_delete_collection",
    {
      title: "Delete Collection",
      description: "Permanently delete a collection and all of its records. Example: use when the user says 'drop the test collection' or 'delete bookmarks'.",
      inputSchema: z.object({ slug: z.string().describe(`${slugDescription} to delete`) }),
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
        slug: z.string().describe(slugDescription),
        record_id: z.number().describe("Record ID to update"),
        data: z.record(z.string(), z.unknown()).describe("New data for the record (replaces existing data)"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, record_id, data }) => {
      const result = await recordService.updateRecord(slug, userId, record_id, data as Record<string, unknown>);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result.record, url: collectionUrl(result.slug) });
    }
  );

  registerTool(
    "hutch_transform_records",
    {
      title: "Transform Records",
      description: "Bulk rename or remove fields across all records in a collection, or set a field on all records or only on those matching set_field.filter (the same filter syntax as hutch_query_records: operators, dotted paths, array elements). Example: use when the user says 'rename status to state across all tasks', 'clear the legacy field' or 'mark every answer with score over 10 as featured'.",
      inputSchema: z.object({
        slug: z.string().describe(slugDescription),
        rename_fields: z.record(z.string(), z.string()).optional().describe("Rename fields: {old_name: new_name} (e.g. {\"status\": \"state\"})"),
        remove_fields: z.array(z.string()).optional().describe("Fields to remove from all records (e.g. [\"legacy_id\"])"),
        set_field: z.object({
          field: z.string().describe("Field name to set"),
          value: z.unknown().describe("New value"),
          filter: z.record(z.string(), z.unknown()).optional().describe("Only update records matching this filter, same syntax as hutch_query_records (e.g. {\"status\": \"active\"} or {\"score\": {\"$gt\": 10}})"),
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
      return jsonResponse({ ...result, url: collectionUrl(result.slug ?? slug) });
    }
  );

  registerTool(
    "hutch_delete_record",
    {
      title: "Delete Record",
      description: "Soft-delete one record by ID. Example: use when the user says 'remove this bookmark' or 'drop record 42'.",
      inputSchema: z.object({
        slug: z.string().describe(slugDescription),
        record_id: z.number().describe("Record ID to delete"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug, record_id }) => {
      const result = await recordService.deleteRecord(slug, userId, record_id);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      const json = JSON.stringify({ deleted: true, record_id, url: collectionUrl(result.slug) });
      return textResponse(`Record ${record_id} deleted.\n\n${json}`);
    }
  );

  registerTool(
    "hutch_infer_schema",
    {
      title: "Infer Schema",
      description: "Analyze existing records to detect field types and save the inferred schema on the collection. Example: use when the user has stored records and asks Hutch to figure out the shape.",
      inputSchema: z.object({ slug: z.string().describe(slugDescription) }),
      // Saves the inferred schema over any manually-set field types — destructive
      // by the same logic as hutch_update_schema.
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await collectionService.inferCollectionSchema(slug, userId);
      if (!result) return collectionNotFound(slug);
      if ('error' in result) return errorResponse(result.error as string);
      return jsonResponse({ ...result, url: collectionUrl(result.slug) });
    }
  );

  registerTool(
    "hutch_update_schema",
    {
      title: "Update Schema",
      description: "Set a field's type, options, position, or visibility on a collection's schema. Example: use when the user says 'make status a select with options todo/done'.",
      inputSchema: z.object({
        slug: z.string().describe(slugDescription),
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
      return jsonResponse({ ...result, url: collectionUrl(result.slug) });
    }
  );

  registerTool(
    "hutch_set_record_status",
    {
      title: "Set Record Status",
      description: "Set one record's status to active, pending, flagged, or archived. Example: use when the user says 'archive this one' or 'flag for review'.",
      inputSchema: z.object({
        slug: z.string().describe(slugDescription),
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
      return jsonResponse({ ...result, url: collectionUrl(result.slug) });
    }
  );

  registerTool(
    "hutch_create_view",
    {
      title: "Create View",
      description: "Create a saved view on a collection (table, kanban, calendar, gallery, etc). Example: use when the user says 'show this as a kanban grouped by status'. For kanban, group_by is auto-inferred to the first select field if omitted.",
      inputSchema: z.object({
        slug: z.string().describe(slugDescription),
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
      return jsonResponse({ ...result.view, url: collectionUrl(result.slug) });
    }
  );

  return server;
}
