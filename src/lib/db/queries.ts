import { cache } from "react";
import { db } from "./index";
import { collections, records, collectionMembers, organizations, organizationMembers, user, type CollectionRole, type OrganizationRole } from "./schema";
import { eq, and, sql, asc, isNull, inArray, SQL } from "drizzle-orm";
import { FIELD_NAME_RE } from "@/lib/constants";
import { isPlainObject } from "@/lib/validation";

export const notDeleted = isNull(records.deletedAt);

export type CollectionAccess = {
  collection: typeof collections.$inferSelect;
  role: CollectionRole;
  /** The org that owns this collection. */
  organization: {
    id: string;
    slug: string;
    name: string;
    personal: boolean;
    /**
     * Caller's role in the org. `null` is the guest case (caller has
     * access via `collection_members` only, not `organization_members`)
     * — they can read/write this specific collection but aren't an org
     * member. Don't conflate `null` with "no access at all"; that's
     * what the function returning `undefined` means.
     */
    callerRole: OrganizationRole | null;
  };
};

const ROLE_RANK: Record<CollectionRole, number> = { viewer: 0, editor: 1, owner: 2 };

function roleAtLeast(actual: CollectionRole, required: CollectionRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

function asRole(role: string | null | undefined): CollectionRole | null {
  return role === "owner" || role === "editor" || role === "viewer" ? role : null;
}

function maxRole(a: CollectionRole | null, b: CollectionRole | null): CollectionRole | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/**
 * Compose the effective role from explicit membership and org membership.
 *
 * Resolution rules (max wins):
 * - Explicit collection_members row → that role
 * - Org admin → implicit owner on every collection in the org
 * - Org member + collection.visibility='org' → collection.org_default_role
 */
function resolveEffectiveRole(
  collection: Pick<typeof collections.$inferSelect, "visibility" | "orgDefaultRole">,
  collectionMemberRole: string | null,
  orgMemberRole: string | null
): CollectionRole | null {
  let effective: CollectionRole | null = asRole(collectionMemberRole);

  if (orgMemberRole === "admin") {
    effective = maxRole(effective, "owner");
  } else if (orgMemberRole === "member" && collection.visibility === "org") {
    const orgDefault = asRole(collection.orgDefaultRole);
    if (orgDefault) effective = maxRole(effective, orgDefault);
  }

  return effective;
}

/**
 * Returns the collection if the user has at least `minRole` access. Combines
 * explicit collection membership with org-level grants (admin → implicit
 * owner; member + visibility='org' → org_default_role).
 *
 * Wrapped in React `cache` so /c/[slug]'s layout + page + downstream
 * authz checks share one DB hit per request.
 */
export const findAccessibleCollectionBySlug = cache(
  async (
    slug: string,
    userId: string,
    minRole: CollectionRole = "viewer",
  ): Promise<CollectionAccess | undefined> => {
    if (!userId) return undefined;

    const [row] = await db
      .select({
        collection: collections,
        memberRole: collectionMembers.role,
        orgMemberRole: organizationMembers.role,
        organizationId: organizations.id,
        organizationSlug: organizations.slug,
        organizationName: organizations.name,
        organizationPersonal: organizations.personal,
      })
      .from(collections)
      .innerJoin(organizations, eq(organizations.id, collections.organizationId))
      .leftJoin(
        collectionMembers,
        and(eq(collectionMembers.collectionId, collections.id), eq(collectionMembers.userId, userId)),
      )
      .leftJoin(
        organizationMembers,
        and(eq(organizationMembers.organizationId, collections.organizationId), eq(organizationMembers.userId, userId)),
      )
      .where(eq(collections.slug, slug))
      .limit(1);

    if (!row) return undefined;

    const role = resolveEffectiveRole(row.collection, row.memberRole, row.orgMemberRole);
    if (!role || !roleAtLeast(role, minRole)) return undefined;
    return {
      collection: row.collection,
      role,
      organization: {
        id: row.organizationId,
        slug: row.organizationSlug,
        name: row.organizationName,
        personal: row.organizationPersonal,
        callerRole: asOrgRole(row.orgMemberRole),
      },
    };
  },
);

function asOrgRole(role: string | null): OrganizationRole | null {
  return role === "admin" || role === "member" ? role : null;
}

/**
 * Look up an existing collection by name within an org. Used by the
 * auto-create path in createRecords to avoid duplicating a collection a
 * user has already made under a different slug.
 */
export async function findCollectionByNameInOrg(name: string, organizationId: string) {
  const [collection] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.name, name), eq(collections.organizationId, organizationId)))
    .limit(1);
  return collection;
}

/**
 * Case-insensitive name lookup against any of the candidate names. Used to
 * resolve a write's raw collection argument ("my_tasks", "tasks") to a
 * collection stored under its normalized name ("My Tasks", "Tasks").
 * idx_collections_org_name is case-sensitive, so several rows can match;
 * the oldest wins for a stable answer.
 */
export async function findCollectionByNameInsensitiveInOrg(names: string[], organizationId: string) {
  const lowered = [...new Set(names.map((n) => n.toLowerCase()))];
  if (lowered.length === 0) return undefined;
  const [collection] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.organizationId, organizationId), inArray(sql`lower(${collections.name})`, lowered)))
    .orderBy(asc(collections.id))
    .limit(1);
  return collection;
}

export async function findCollectionBySlugInOrg(slug: string, organizationId: string) {
  const [collection] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.slug, slug), eq(collections.organizationId, organizationId)))
    .limit(1);
  return collection;
}

/**
 * Insert a collection and its owner row atomically. The collection lands in
 * the supplied org; the caller becomes its owner via collection_members.
 */
export async function createCollectionWithOwner(
  values: Omit<typeof collections.$inferInsert, "organizationId"> & {
    organizationId: string;
    ownerUserId: string;
  }
): Promise<typeof collections.$inferSelect> {
  const { ownerUserId, ...collectionValues } = values;
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(collections).values(collectionValues).returning();
    await tx
      .insert(collectionMembers)
      .values({ collectionId: created.id, userId: ownerUserId, role: "owner" })
      .onConflictDoNothing();
    return created;
  });
}

/**
 * Look up a user by email, case-insensitive. Returns undefined when no match.
 */
export async function findUserByEmail(email: string): Promise<{ id: string; name: string | null; email: string } | undefined> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const [row] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalized}`)
    .limit(1);
  return row;
}

export async function findPublishedCollectionBySlug(slug: string) {
  const [collection] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.slug, slug), eq(collections.published, true)))
    .limit(1);
  return collection;
}

export async function getCollectionRecordCount(collectionId: number): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(records)
    .where(and(eq(records.collectionId, collectionId), notDeleted));
  return result?.count ?? 0;
}

export async function getLastRecordAt(collectionId: number): Promise<Date | null> {
  const [result] = await db
    .select({ lastAt: sql<Date>`max(${records.createdAt})` })
    .from(records)
    .where(and(eq(records.collectionId, collectionId), notDeleted))
    .limit(1);
  return result?.lastAt ?? null;
}

export type QueryParams = {
  collectionId: number;
  filter?: Record<string, unknown>;
  search?: string;
  searchFields?: string[];
  sort?: string;
  fields?: string[];
  /** One field, or up to MAX_GROUP_BY_KEYS fields; each may be a dotted object path. */
  groupBy?: string | string[];
  aggregate?: Record<string, string | Record<string, string>>;
  timeBucket?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
  /** Internal: raises the 1000-row limit ceiling (used by export). Not exposed via MCP. */
  limitCap?: number;
};

export const SORT_FIELD_HELP =
  "sort accepts a top-level field name, a dotted path into nested objects (a.b.c), id, created_at or updated_at, optionally prefixed with - for descending";

export const MAX_GROUP_BY_KEYS = 3;

/**
 * A field name, or a dotted path into nested objects ("totals.veterans.points").
 * Every segment is letters, digits and underscores only, so a validated path
 * can never carry quotes, braces or commas into SQL.
 */
const FIELD_PATH_RE = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Segments of a dotted object path, or null when `field` is not one (plain keys stay literal). */
function dottedPathSegments(field: string): string[] | null {
  return field.includes(".") && FIELD_PATH_RE.test(field) ? field.split(".") : null;
}

/** Postgres text[] literal for a validated path, bound as a parameter for `#>` / `#>>`. */
function pathLiteral(segments: string[]): string {
  return `{${segments.join(",")}}`;
}

/** {a: {b: {c: value}}} for path [a, b, c] — the containment shape of a dotted filter. */
function nestValue(segments: string[], value: unknown): Record<string, unknown> {
  return segments.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>;
}

export const FILTER_OPERATORS = ["$gt", "$gte", "$lt", "$lte", "$ne", "$in", "$nin", "$exists", "$contains"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

type ComparisonOp = Extract<FilterOperator, "$gt" | "$gte" | "$lt" | "$lte">;
const COMPARISON_OPS: Record<ComparisonOp, string> = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" };

const IN_ARRAY_LIMIT = 1000;

/**
 * An operator spec is an object value whose keys ALL start with `$`
 * (e.g. {"$gte": 10, "$lt": 100}). Anything else — plain values, arrays,
 * nested objects, mixed keys — falls back to JSONB containment, which
 * keeps existing filter call shapes byte-for-byte compatible.
 */
function isOperatorSpec(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * Build WHERE conditions for a filter object. Plain (non-operator) pairs
 * are collected into a single JSONB containment condition, exactly as
 * before; operator pairs each compile to a guarded, fully parameterized
 * comparison. Numeric comparisons only apply where
 * jsonb_typeof(data->field) = 'number' so mixed-type fields can't raise
 * cast errors; string operands compare lexicographically as text (which
 * also works for ISO-8601 date strings).
 */
export function buildFilterConditions(filter: Record<string, unknown>): SQL[] {
  const conditions: SQL[] = [];
  const containment: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(filter)) {
    // A dotted key ("address.city") addresses a nested object, and still
    // matches a literal top-level key of that name (e.g. a CSV column
    // "first.name"), as it did before paths existed. Any other key is a
    // literal top-level key.
    const path = dottedPathSegments(field);
    if (isOperatorSpec(value)) {
      for (const [op, operand] of Object.entries(value)) {
        conditions.push(buildOperatorCondition(field, op, operand, path));
      }
    } else if (path) {
      conditions.push(sql`(${records.data} @> ${JSON.stringify(nestValue(path, value))}::jsonb OR ${records.data} @> ${JSON.stringify({ [field]: value })}::jsonb)`);
    } else {
      containment[field] = value;
    }
  }

  if (Object.keys(containment).length > 0) {
    conditions.unshift(sql`${records.data} @> ${JSON.stringify(containment)}::jsonb`);
  }

  return conditions;
}

function buildOperatorCondition(field: string, op: string, operand: unknown, path: string[] | null = null): SQL {
  // Top-level fields keep their original `->` / `->>` / `?` SQL; dotted
  // object paths use `#>` / `#>>` with the path bound as a text[] parameter,
  // falling back to a literal top-level key of the same name.
  const json = path ? sql`coalesce(${records.data} #> ${pathLiteral(path)}::text[], ${records.data}->${field})` : sql`${records.data}->${field}`;
  const text = path ? sql`coalesce(${records.data} #>> ${pathLiteral(path)}::text[], ${records.data}->>${field})` : sql`${records.data}->>${field}`;
  const contains = (v: unknown) => path
    ? sql`(${records.data} @> ${JSON.stringify(nestValue(path, v))}::jsonb OR ${records.data} @> ${JSON.stringify({ [field]: v })}::jsonb)`
    : sql`${records.data} @> ${JSON.stringify({ [field]: v })}::jsonb`;

  if (Object.hasOwn(COMPARISON_OPS, op)) {
    const cmp = sql.raw(COMPARISON_OPS[op as ComparisonOp]);
    if (typeof operand === "number") {
      return sql`(jsonb_typeof(${json}) = 'number' AND (${text})::numeric ${cmp} ${operand})`;
    }
    if (typeof operand === "string") {
      return sql`(jsonb_typeof(${json}) = 'string' AND (${text}) ${cmp} ${operand})`;
    }
    throw new Error(`${op} requires a number or string operand`);
  }

  switch (op) {
    case "$ne":
      // Mongo semantics: matches records where the field differs OR is absent.
      return sql`NOT (${contains(operand)})`;
    case "$in":
    case "$nin": {
      if (!Array.isArray(operand)) throw new Error(`${op} requires an array operand`);
      if (operand.length > IN_ARRAY_LIMIT) {
        throw new Error(`$in/$nin arrays are limited to ${IN_ARRAY_LIMIT} elements`);
      }
      if (operand.length === 0) {
        // $in [] matches nothing; $nin [] matches everything.
        return op === "$in" ? sql`false` : sql`true`;
      }
      const list = sql.join(operand.map((v) => sql`${JSON.stringify(v)}::jsonb`), sql`, `);
      const inCondition = sql`${json} = ANY(ARRAY[${list}])`;
      return op === "$in"
        ? inCondition
        : sql`(${json} IS NULL OR NOT (${inCondition}))`;
    }
    case "$exists":
      if (typeof operand !== "boolean") throw new Error("$exists requires a boolean operand");
      if (path) {
        // `#>` yields SQL NULL only when the key is absent (a stored JSON null is present).
        return operand ? sql`${json} IS NOT NULL` : sql`${json} IS NULL`;
      }
      return operand ? sql`${records.data} ? ${field}` : sql`NOT (${records.data} ? ${field})`;
    case "$contains": {
      if (typeof operand !== "string") throw new Error("$contains requires a string operand");
      const pattern = `%${operand.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      return sql`(jsonb_typeof(${json}) = 'string' AND (${text}) ILIKE ${pattern})`;
    }
    default:
      throw new Error(`Unsupported filter operator '${op}'. Supported: ${FILTER_OPERATORS.join(", ")}`);
  }
}

/** Keep only the requested top-level keys of a record's data (projection). */
function projectData(data: unknown, fields: string[]): unknown {
  if (!isPlainObject(data)) return data;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(data, field)) projected[field] = data[field];
  }
  return projected;
}

export async function queryRecords(params: QueryParams) {
  const {
    collectionId,
    filter,
    search,
    sort,
    fields,
    createdAfter,
    createdBefore,
    limit = 50,
    offset = 0,
    limitCap = 1000,
    groupBy,
    aggregate,
    timeBucket,
  } = params;

  const conditions: SQL[] = [eq(records.collectionId, collectionId), notDeleted];

  if (filter && Object.keys(filter).length > 0) {
    conditions.push(...buildFilterConditions(filter));
  }

  if (search) {
    conditions.push(
      sql`to_tsvector('english', ${records.data}::text) @@ plainto_tsquery('english', ${search})`
    );
  }

  if (createdAfter) {
    conditions.push(sql`${records.createdAt} >= ${createdAfter}::timestamptz`);
  }

  if (createdBefore) {
    conditions.push(sql`${records.createdAt} < ${createdBefore}::timestamptz`);
  }

  const whereClause = conditions.length > 1
    ? and(...conditions)!
    : conditions[0];

  // Handle aggregation queries
  const groupByKeys = normalizeGroupBy(groupBy);
  if (groupByKeys.length > 0 || aggregate) {
    return queryWithAggregation(whereClause, { groupBy: groupByKeys, aggregate, timeBucket, sort, limit });
  }

  const { orderBy, valuePath: sortPath } = buildRecordSort(sort);

  const clampedLimit = Math.min(Math.max(limit, 1), limitCap);

  const selectQuery = db
    .select()
    .from(records)
    .where(whereClause)
    .orderBy(orderBy)
    .limit(clampedLimit)
    .offset(offset);

  let results: typeof selectQuery extends Promise<infer R> ? R : never;
  let total: number;

  if (offset === 0) {
    // First page: wait for results; if they fit in one page, results.length is the total.
    results = await selectQuery;
    await assertSortedPageIsOrdered(collectionId, sort, sortPath, results);
    total = results.length < clampedLimit ? results.length : await runCount(whereClause);
  } else {
    // Paginated read: count and results are independent — run in parallel.
    const [rs, [{ count }]] = await Promise.all([selectQuery, runCountQuery(whereClause)]);
    results = rs;
    total = count;
    await assertSortedPageIsOrdered(collectionId, sort, sortPath, results);
  }

  const projected = fields && fields.length > 0
    ? results.map((r) => ({ ...r, data: projectData(r.data, fields) }))
    : results;

  const hasMore = offset + results.length < total;
  return {
    records: projected,
    total,
    count: results.length,
    limit: clampedLimit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + results.length : null,
  };
}

/**
 * ORDER BY for a records query. `valuePath` is the data path the sort reads
 * (absent for system columns and `id`), used to detect a sort on a field no
 * record has. Every order ends on the row id so ties (equal values, records
 * from one batch sharing created_at) come back in the same order every time
 * and top-N pages are stable.
 */
export function buildRecordSort(sort: string | undefined): { orderBy: SQL; valuePath?: string[] } {
  if (sort === undefined || sort === null || sort === "") {
    return { orderBy: sql`${records.createdAt} DESC, ${records.id} DESC` };
  }
  const descending = sort.startsWith("-");
  const field = descending ? sort.slice(1) : sort;
  const dir = sql.raw(descending ? "DESC" : "ASC");

  if (field === "created_at") return { orderBy: sql`${records.createdAt} ${dir}, ${records.id} ${dir}` };
  if (field === "updated_at") return { orderBy: sql`${records.updatedAt} ${dir}, ${records.id} ${dir}` };
  if (field === "id") {
    // A data field named `id` sorts as it always has; records without one
    // (the usual case) fall through to the record id, so `id` is always valid.
    return { orderBy: sql`${records.data}->${field} ${dir} NULLS LAST, ${records.id} ${dir}` };
  }
  if (FIELD_NAME_RE.test(field)) {
    // `->` keeps jsonb typing so numbers sort numerically; `->>` would cast
    // to text and sort them lexicographically ("12" < "3" < "5").
    return { orderBy: sql`${records.data}->${field} ${dir} NULLS LAST, ${records.id} ASC`, valuePath: [field] };
  }
  const path = dottedPathSegments(field);
  if (path) {
    // `#>` keeps jsonb typing too.
    return { orderBy: sql`${records.data} #> ${pathLiteral(path)}::text[] ${dir} NULLS LAST, ${records.id} ASC`, valuePath: path };
  }
  throw new Error(`Invalid sort field '${field}' — ${SORT_FIELD_HELP}`);
}

function valueAtPath(data: unknown, path: string[]): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * A sort on a field or path no record has (a typo, or a path into an
 * array) orders every row by NULL and would silently return the default
 * order. Sorting is NULLS LAST, so when the page's first row has a value
 * the sort was applied and no extra query runs; otherwise one EXISTS
 * probe over the collection's live records decides whether to refuse it.
 * An empty page has no order to get wrong.
 */
async function assertSortedPageIsOrdered(
  collectionId: number,
  sort: string | undefined,
  path: string[] | undefined,
  rows: { data: unknown }[],
): Promise<void> {
  if (!path || rows.length === 0 || valueAtPath(rows[0].data, path) !== undefined) return;
  const [found] = await db
    .select({ one: sql<number>`1` })
    .from(records)
    .where(and(eq(records.collectionId, collectionId), notDeleted, sql`${records.data} #> ${pathLiteral(path)}::text[] IS NOT NULL`))
    .limit(1);
  if (!found) {
    const field = sort!.startsWith("-") ? sort!.slice(1) : sort!;
    throw new Error(`Invalid sort field '${field}': no record in this collection has it — ${SORT_FIELD_HELP}`);
  }
}

function runCountQuery(whereClause: SQL) {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(records)
    .where(whereClause);
}

async function runCount(whereClause: SQL): Promise<number> {
  const [{ count }] = await runCountQuery(whereClause);
  return count;
}

const AGGREGATION_OPS = "count, min, max, distinct, sum, avg";

/** Internal column carrying the group count; stripped from every result row. */
const TOTAL_COLUMN = "__hutch_total";

export function normalizeGroupBy(groupBy: string | string[] | undefined): string[] {
  if (Array.isArray(groupBy)) {
    if (groupBy.length > MAX_GROUP_BY_KEYS) throw new Error(`group_by accepts at most ${MAX_GROUP_BY_KEYS} keys`);
    for (const key of groupBy) {
      if (typeof key !== "string") throw new Error("group_by must be a field name or an array of field names");
      escapeFieldPath(key);
    }
    return groupBy;
  }
  return groupBy ? [groupBy] : [];
}

/** `data->'f'` for a top-level field, `data #> '{a,b,c}'` for a dotted object path (jsonb). */
function jsonbAt(field: string): string {
  const segments = escapeFieldPath(field).split(".");
  return segments.length === 1 ? `data->'${segments[0]}'` : `data #> '${pathLiteral(segments)}'`;
}

/** `data->>'f'` / `data #>> '{a,b,c}'` (text). */
function textAt(field: string): string {
  const segments = escapeFieldPath(field).split(".");
  return segments.length === 1 ? `data->>'${segments[0]}'` : `data #>> '${pathLiteral(segments)}'`;
}

/**
 * Build the aggregate statement. Every identifier and path is validated
 * (escapeField / escapeFieldPath) before it is interpolated; filter values
 * stay bound parameters inside whereClause.
 *
 * Ordering happens before LIMIT, so `sort: "-alias", limit: 10` is the true
 * top 10 groups. `count(*) OVER ()` runs after grouping and before LIMIT,
 * giving the number of groups for the response's `total`.
 */
export function buildAggregationQuery(
  whereClause: SQL,
  params: { groupBy?: string[]; aggregate?: Record<string, string | Record<string, string>>; timeBucket?: string; sort?: string; limit?: number }
): SQL {
  const { groupBy = [], aggregate, timeBucket, sort, limit = 50 } = params;

  const selectParts: string[] = [];
  const groupByParts: string[] = [];
  // Output columns addressable by sort, mapped to their select-list ordinal.
  // Ordinals keep ORDER BY unambiguous with real columns such as `status`.
  const sortable = new Map<string, number>();
  const defaultOrder: number[] = [];

  if (timeBucket) {
    selectParts.push(`date_trunc('${escapeBucket(timeBucket)}', created_at) as time_bucket`);
    groupByParts.push(`date_trunc('${escapeBucket(timeBucket)}', created_at)`);
    sortable.set("time_bucket", selectParts.length);
    defaultOrder.push(selectParts.length);
  }

  for (const key of groupBy) {
    // Result columns are named by the key itself; a validated path only
    // holds [a-zA-Z0-9_.], so it is safe inside a quoted identifier.
    selectParts.push(`${textAt(key)} as "${escapeFieldPath(key)}"`);
    groupByParts.push(textAt(key));
    sortable.set(key, selectParts.length);
    // Without a time bucket the first group key leads the default order, as
    // before; further keys make the order within it deterministic.
    defaultOrder.push(selectParts.length);
  }

  if (aggregate) {
    for (const [alias, spec] of Object.entries(aggregate)) {
      if (spec === "count" || (isPlainObject(spec) && "count" in spec)) {
        selectParts.push(`count(*)::int as "${escapeField(alias)}"`);
        sortable.set(alias, selectParts.length);
        continue;
      }
      const specEntry = isPlainObject(spec) ? Object.entries(spec)[0] : undefined;
      if (!specEntry) {
        const label = typeof spec === "string" ? spec : JSON.stringify(spec);
        throw new Error(`Unsupported aggregation '${label}'. Supported: ${AGGREGATION_OPS}`);
      }
      const [op, field] = specEntry;
      const json = jsonbAt(field);
      const text = textAt(field);
      const safeAlias = escapeField(alias);
      // Numeric values only (jsonb_typeof guard), so mixed-type fields can't
      // raise cast errors. Results go through to_jsonb because node-postgres
      // returns a bare numeric as a string; jsonb comes back as a JS number.
      const numeric = `CASE WHEN jsonb_typeof(${json}) = 'number' THEN (${text})::numeric END`;
      switch (op) {
        case "min":
        case "max":
          // Numeric when the field holds any numbers (as text "10" < "9"),
          // otherwise text so strings and ISO dates still order correctly.
          selectParts.push(`coalesce(to_jsonb(${op}(${numeric})), to_jsonb(${op}(${text}))) as "${safeAlias}"`);
          break;
        case "distinct":
          selectParts.push(`array_agg(distinct ${text}) as "${safeAlias}"`);
          break;
        case "sum":
        case "avg":
          // NULL when the group has no numeric values.
          selectParts.push(`to_jsonb(${op}(${numeric})) as "${safeAlias}"`);
          break;
        default:
          throw new Error(`Unsupported aggregation '${op}'. Supported: ${AGGREGATION_OPS}`);
      }
      sortable.set(alias, selectParts.length);
    }
  } else {
    selectParts.push("count(*)::int as count");
    sortable.set("count", selectParts.length);
  }

  let order = defaultOrder.map((n) => `${n} ASC`);
  if (sort) {
    const descending = sort.startsWith("-");
    const field = descending ? sort.slice(1) : sort;
    const ordinal = sortable.get(field);
    if (ordinal === undefined) {
      throw new Error(
        `Invalid sort field '${field}' for a group_by/aggregate query — sort accepts an aggregate alias or a group_by key here (${[...sortable.keys()].join(", ")}), optionally prefixed with - for descending`
      );
    }
    order = [`${ordinal} ${descending ? "DESC" : "ASC"} NULLS LAST`, ...defaultOrder.filter((n) => n !== ordinal).map((n) => `${n} ASC`)];
  }

  selectParts.push(`count(*) OVER ()::int as "${TOTAL_COLUMN}"`);

  const selectClause = selectParts.join(", ");
  const groupClause = groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(", ")}` : "";
  const orderClause = order.length > 0 ? `ORDER BY ${order.join(", ")}` : "";

  return sql`
    SELECT ${sql.raw(selectClause)}
    FROM records
    WHERE ${whereClause}
    ${sql.raw(groupClause)}
    ${sql.raw(orderClause)}
    LIMIT ${Math.min(limit, 1000)}
  `;
}

async function queryWithAggregation(
  whereClause: SQL,
  params: { groupBy?: string[]; aggregate?: Record<string, string | Record<string, string>>; timeBucket?: string; sort?: string; limit?: number }
) {
  const rows = await db.execute(buildAggregationQuery(whereClause, params));
  const raw = rows.rows as Record<string, unknown>[];
  const total = raw.length > 0 ? Number(raw[0][TOTAL_COLUMN] ?? raw.length) : 0;
  const results = raw.map(({ [TOTAL_COLUMN]: _total, ...rest }) => rest);
  return { results, total };
}

function escapeField(field: string): string {
  if (!FIELD_NAME_RE.test(field)) {
    throw new Error(`Invalid field name '${field}' — only letters, numbers, and underscores are allowed`);
  }
  return field;
}

/** escapeField for a field or a dotted path into nested objects (each segment as strict as a field name). */
function escapeFieldPath(field: string): string {
  if (typeof field !== "string" || !FIELD_PATH_RE.test(field)) {
    throw new Error(`Invalid field name '${field}' — only letters, numbers, and underscores are allowed, with dots separating nested object keys`);
  }
  return field;
}

function escapeBucket(bucket: string): string {
  const allowed = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"];
  return allowed.includes(bucket) ? bucket : "day";
}
