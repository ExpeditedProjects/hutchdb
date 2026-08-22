import { cache } from "react";
import { db } from "./index";
import { collections, records, collectionMembers, organizations, organizationMembers, user, type CollectionRole, type OrganizationRole } from "./schema";
import { eq, and, sql, desc, asc, isNull, SQL } from "drizzle-orm";
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
  groupBy?: string;
  aggregate?: Record<string, string | Record<string, string>>;
  timeBucket?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
  /** Internal: raises the 1000-row limit ceiling (used by export). Not exposed via MCP. */
  limitCap?: number;
};

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
    if (isOperatorSpec(value)) {
      for (const [op, operand] of Object.entries(value)) {
        conditions.push(buildOperatorCondition(field, op, operand));
      }
    } else {
      containment[field] = value;
    }
  }

  if (Object.keys(containment).length > 0) {
    conditions.unshift(sql`${records.data} @> ${JSON.stringify(containment)}::jsonb`);
  }

  return conditions;
}

function buildOperatorCondition(field: string, op: string, operand: unknown): SQL {
  if (Object.hasOwn(COMPARISON_OPS, op)) {
    const cmp = sql.raw(COMPARISON_OPS[op as ComparisonOp]);
    if (typeof operand === "number") {
      return sql`(jsonb_typeof(${records.data}->${field}) = 'number' AND (${records.data}->>${field})::numeric ${cmp} ${operand})`;
    }
    if (typeof operand === "string") {
      return sql`(jsonb_typeof(${records.data}->${field}) = 'string' AND (${records.data}->>${field}) ${cmp} ${operand})`;
    }
    throw new Error(`${op} requires a number or string operand`);
  }

  switch (op) {
    case "$ne":
      // Mongo semantics: matches records where the field differs OR is absent.
      return sql`NOT (${records.data} @> ${JSON.stringify({ [field]: operand })}::jsonb)`;
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
      const inCondition = sql`${records.data}->${field} = ANY(ARRAY[${list}])`;
      return op === "$in"
        ? inCondition
        : sql`(${records.data}->${field} IS NULL OR NOT (${inCondition}))`;
    }
    case "$exists":
      if (typeof operand !== "boolean") throw new Error("$exists requires a boolean operand");
      return operand ? sql`${records.data} ? ${field}` : sql`NOT (${records.data} ? ${field})`;
    case "$contains": {
      if (typeof operand !== "string") throw new Error("$contains requires a string operand");
      const pattern = `%${operand.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      return sql`(jsonb_typeof(${records.data}->${field}) = 'string' AND (${records.data}->>${field}) ILIKE ${pattern})`;
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
  if (groupBy || aggregate) {
    return queryWithAggregation(whereClause, { groupBy, aggregate, timeBucket, limit });
  }

  // Build sort
  let orderBy: SQL;
  if (sort) {
    const descending = sort.startsWith("-");
    const field = descending ? sort.slice(1) : sort;
    if (field === "created_at") {
      orderBy = descending ? desc(records.createdAt) : asc(records.createdAt);
    } else if (field === "updated_at") {
      orderBy = descending ? desc(records.updatedAt) : asc(records.updatedAt);
    } else if (/^[a-zA-Z0-9_]+$/.test(field)) {
      orderBy = descending
        ? sql`${records.data}->>${field} DESC NULLS LAST`
        : sql`${records.data}->>${field} ASC NULLS LAST`;
    } else {
      orderBy = desc(records.createdAt);
    }
  } else {
    orderBy = desc(records.createdAt);
  }

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
    total = results.length < clampedLimit ? results.length : await runCount(whereClause);
  } else {
    // Paginated read: count and results are independent — run in parallel.
    const [rs, [{ count }]] = await Promise.all([selectQuery, runCountQuery(whereClause)]);
    results = rs;
    total = count;
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

async function queryWithAggregation(
  whereClause: SQL,
  params: { groupBy?: string; aggregate?: Record<string, string | Record<string, string>>; timeBucket?: string; limit?: number }
) {
  const { groupBy, aggregate, timeBucket, limit = 50 } = params;

  const selectParts: string[] = [];
  const groupByParts: string[] = [];

  if (timeBucket) {
    selectParts.push(`date_trunc('${escapeBucket(timeBucket)}', created_at) as time_bucket`);
    groupByParts.push(`date_trunc('${escapeBucket(timeBucket)}', created_at)`);
  }

  if (groupBy) {
    selectParts.push(`data->>'${escapeField(groupBy)}' as "${escapeField(groupBy)}"`);
    groupByParts.push(`data->>'${escapeField(groupBy)}'`);
  }

  if (aggregate) {
    for (const [alias, spec] of Object.entries(aggregate)) {
      if (spec === "count" || (isPlainObject(spec) && "count" in spec)) {
        selectParts.push(`count(*)::int as "${escapeField(alias)}"`);
        continue;
      }
      const specEntry = isPlainObject(spec) ? Object.entries(spec)[0] : undefined;
      if (!specEntry) {
        const label = typeof spec === "string" ? spec : JSON.stringify(spec);
        throw new Error(`Unsupported aggregation '${label}'. Supported: ${AGGREGATION_OPS}`);
      }
      const [op, field] = specEntry;
      const safeField = escapeField(field);
      const safeAlias = escapeField(alias);
      switch (op) {
        case "min":
          selectParts.push(`min(data->>'${safeField}') as "${safeAlias}"`);
          break;
        case "max":
          selectParts.push(`max(data->>'${safeField}') as "${safeAlias}"`);
          break;
        case "distinct":
          selectParts.push(`array_agg(distinct data->>'${safeField}') as "${safeAlias}"`);
          break;
        case "sum":
        case "avg":
          // Aggregate only numeric values (jsonb_typeof guard) so mixed-type
          // fields can't raise cast errors; NULL when no numeric values exist.
          selectParts.push(`${op}(CASE WHEN jsonb_typeof(data->'${safeField}') = 'number' THEN (data->>'${safeField}')::numeric END) as "${safeAlias}"`);
          break;
        default:
          throw new Error(`Unsupported aggregation '${op}'. Supported: ${AGGREGATION_OPS}`);
      }
    }
  } else {
    selectParts.push("count(*)::int as count");
  }

  const selectClause = selectParts.join(", ");
  const groupClause = groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(", ")}` : "";
  const orderClause = timeBucket ? "ORDER BY time_bucket ASC" : (groupBy ? `ORDER BY "${escapeField(groupBy)}" ASC` : "");

  const query = sql`
    SELECT ${sql.raw(selectClause)}
    FROM records
    WHERE ${whereClause}
    ${sql.raw(groupClause)}
    ${sql.raw(orderClause)}
    LIMIT ${Math.min(limit, 1000)}
  `;

  const rows = await db.execute(query);
  return { results: rows.rows };
}

function escapeField(field: string): string {
  if (!FIELD_NAME_RE.test(field)) {
    throw new Error(`Invalid field name '${field}' — only letters, numbers, and underscores are allowed`);
  }
  return field;
}

function escapeBucket(bucket: string): string {
  const allowed = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"];
  return allowed.includes(bucket) ? bucket : "day";
}
