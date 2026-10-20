import { cache } from "react";
import { db } from "./index";
import { collections, collectionMembers, organizations, organizationMembers, user, type CollectionRole, type OrganizationRole } from "./schema";
import { eq, and, sql, asc, inArray } from "drizzle-orm";
import { isPlainObject } from "@/lib/validation";
import { createCollectionTable } from "@/lib/storage/ddl";

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
 * Insert a collection, its owner row and its hc_<id> table atomically. The collection lands in
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
    // Every collection's rows live in its own table (src/lib/storage).
    await createCollectionTable(tx, created.id);
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
  /** Aggregates over a nested array only: false omits the embedded parent `record`. */
  record?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
  /** Internal: raises the 1000-row limit ceiling (used by export). Not exposed via MCP. */
  limitCap?: number;
};

export const MAX_GROUP_BY_KEYS = 3;

export const FILTER_OPERATORS = ["$gt", "$gte", "$lt", "$lte", "$ne", "$in", "$nin", "$exists", "$contains"] as const;

/**
 * An operator spec is an object value whose keys ALL start with `$`
 * (e.g. {"$gte": 10, "$lt": 100}). Anything else — plain values, arrays,
 * nested objects, mixed keys — is a plain value (containment).
 */
export function isOperatorSpec(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/** Keep only the requested top-level keys of a record's data (projection). */
export function projectData(data: unknown, fields: string[]): unknown {
  if (!isPlainObject(data)) return data;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(data, field)) projected[field] = data[field];
  }
  return projected;
}

export const AGGREGATION_OPS = "count, min, max, distinct, sum, avg";

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

/**
 * A field name, or a dotted path into nested objects ("totals.veterans.points").
 * Every segment is letters, digits and underscores only, so a validated path
 * can never carry quotes, braces or commas into SQL.
 */
const FIELD_PATH_RE = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** A field or a dotted path into nested objects (each segment as strict as a field name). */
function escapeFieldPath(field: string): string {
  if (typeof field !== "string" || !FIELD_PATH_RE.test(field)) {
    throw new Error(`Invalid field name '${field}' — only letters, numbers, and underscores are allowed, with dots separating nested object keys`);
  }
  return field;
}

export function escapeBucket(bucket: string): string {
  const allowed = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"];
  return allowed.includes(bucket) ? bucket : "day";
}
