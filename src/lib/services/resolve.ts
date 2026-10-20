import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import type { CollectionRole } from "@/lib/db/schema";
import { findAccessibleCollectionBySlug, type CollectionAccess } from "@/lib/db/queries";
import { titleCase } from "@/lib/slugify";

/** How many same-named collections the name fallback looks at. */
const NAME_CANDIDATES = 20;

/**
 * The collection a tool's `slug` argument refers to, if the user has at
 * least `minRole` on it. The argument is a slug first; when no collection
 * has that slug, it may be the collection's name, resolved the way
 * hutch_store_records resolves its `collection` argument (exact name, or
 * case-insensitively the name or its title-cased form, so "tags" finds
 * the "Tags" collection stored as tags-dfaaa941). A name counts only when
 * it is unambiguous among the collections the user can see: an exact-case
 * match wins over case-insensitive ones, and two equally good matches
 * resolve to nothing.
 */
export async function findAccessibleCollection(ref: string, userId: string, minRole: CollectionRole = "viewer"): Promise<CollectionAccess | undefined> {
  const bySlug = await findAccessibleCollectionBySlug(ref, userId, minRole);
  if (bySlug || !userId || !ref) return bySlug;

  const names = [...new Set([ref, titleCase(ref)].map((n) => n.toLowerCase()))];
  const result = await db.execute(sql`
    SELECT slug, name FROM collections
    WHERE lower(name) IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
    ORDER BY id
    LIMIT ${NAME_CANDIDATES}`);
  const rows = (Array.isArray(result?.rows) ? result.rows : []) as { slug?: unknown; name?: unknown }[];
  const candidates = rows.filter((r): r is { slug: string; name: string } => typeof r.slug === "string" && typeof r.name === "string" && r.slug !== ref);

  const visible: { slug: string; name: string }[] = [];
  for (const c of candidates) {
    if (await findAccessibleCollectionBySlug(c.slug, userId, "viewer")) visible.push(c);
  }
  const exact = visible.filter((c) => c.name === ref);
  const pick = exact.length === 1 ? exact[0] : exact.length === 0 && visible.length === 1 ? visible[0] : undefined;
  if (!pick) return undefined;
  return findAccessibleCollectionBySlug(pick.slug, userId, minRole);
}
