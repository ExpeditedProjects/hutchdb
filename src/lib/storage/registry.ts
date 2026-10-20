import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

/**
 * Storage registry for a layout='table' collection: what inference created
 * on its hc_<id> table. Persisted verbatim in collections.storage.
 */
export type ProjectionType = "number" | "text" | "boolean" | "date";

export type Projection = {
  /**
   * JSON key, exactly as it appears in documents; for a nested object path,
   * its segments joined with dots ("totals.veterans.points").
   */
  field: string;
  /**
   * Segments of a nested object path (2 or 3 keys). Absent for a top-level
   * key, so a top-level key that itself contains dots never collides with
   * a path.
   */
  path?: string[];
  /** Sanitized column name on the collection table (p_<...>). */
  column: string;
  type: ProjectionType;
  reason: string;
  /**
   * Sticky: some live document has held a value at this field that is not
   * of `type` (including JSON null). The column is NULL for those, so the
   * compiler stops using it for sorts and date ranges, where it would order
   * them differently from the document; filters stay exact either way.
   */
  mixed?: boolean;
};

export type UnwindField = {
  field: string;
  column: string;
  type: ProjectionType;
};

export type Unwind = {
  /** Top-level JSON key holding the array of objects. */
  path: string;
  /** Child table name (hc_<id>__<...>). */
  table: string;
  fields: UnwindField[];
  reason: string;
};

export type StorageRegistry = {
  projections: Projection[];
  unwinds: Unwind[];
  evaluated_rows: number;
  /** Unique key the uk_* columns and hc_<id>_uk index currently reflect. */
  unique_key?: string[];
  /** Arrays of objects that are not unwound yet, each with the latest reason (below threshold, mixed shapes, a failed attempt, ...). */
  pending_unwinds?: { path: string; reason: string }[];
};

export const EMPTY_REGISTRY: StorageRegistry = { projections: [], unwinds: [], evaluated_rows: 0 };

export type StorageLayout = "shared" | "table";

/** The layout new collections get. Read at call time so tests can flip it. */
export function defaultStorageLayout(): StorageLayout {
  return process.env.HUTCH_STORAGE_LAYOUT === "table" ? "table" : "shared";
}

export function isTableLayout(collection: { layout?: string | null } | null | undefined): boolean {
  return collection?.layout === "table";
}

/** Normalize whatever is in collections.storage into a full registry. */
export function readRegistry(raw: unknown): StorageRegistry {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<StorageRegistry>;
  return {
    projections: Array.isArray(r.projections) ? r.projections : [],
    unwinds: Array.isArray(r.unwinds) ? r.unwinds : [],
    evaluated_rows: typeof r.evaluated_rows === "number" ? r.evaluated_rows : 0,
    ...(Array.isArray(r.unique_key) ? { unique_key: r.unique_key } : {}),
    ...(Array.isArray(r.pending_unwinds) ? { pending_unwinds: r.pending_unwinds } : {}),
  };
}

// ── Identifiers ──────────────────────────────────────────────────────────────

/** Postgres truncates identifiers longer than this (NAMEDATALEN - 1). */
export const PG_MAX_IDENTIFIER = 63;

const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/** Max length of the user-derived part of a column or table name. */
const MAX_FRAGMENT = 40;

export function shortHash(input: string, length = 8): string {
  return createHash("sha1").update(input).digest("hex").slice(0, length);
}

/**
 * Turn a user-supplied JSON key into a safe SQL identifier fragment:
 * lowercase ASCII letters, digits and underscores only, never empty, never
 * starting with a digit, at most MAX_FRAGMENT characters (long names keep a
 * hash of the original so distinct keys stay distinct).
 */
export function sanitizeIdentifier(raw: string): string {
  let s = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s === "") s = "f";
  if (/^[0-9]/.test(s)) s = `f_${s}`;
  if (s.length > MAX_FRAGMENT) {
    s = `${s.slice(0, MAX_FRAGMENT - 9)}_${shortHash(raw)}`;
  }
  return s;
}

/** Pick a column name for `field` that no existing entry already uses. */
export function uniqueColumnName(field: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `p_${sanitizeIdentifier(field)}`;
  if (!used.has(base)) return base;
  let candidate = `${base}_${shortHash(field, 6)}`;
  for (let i = 2; used.has(candidate); i++) candidate = `${base}_${shortHash(field, 6)}_${i}`;
  return candidate;
}

export function collectionTableName(collectionId: number): string {
  assertCollectionId(collectionId);
  return `hc_${collectionId}`;
}

export function childTableName(collectionId: number, path: string): string {
  return `${collectionTableName(collectionId)}__${sanitizeIdentifier(path)}`;
}

/** Index name for (table, column), shortened with a hash when too long. */
export function indexName(table: string, column: string): string {
  const natural = `${table}_${column}_idx`;
  if (natural.length <= PG_MAX_IDENTIFIER) return natural;
  return `${table.slice(0, PG_MAX_IDENTIFIER - 13)}_${shortHash(column)}_idx`;
}

export function uniqueIndexName(table: string): string {
  return `${table}_uk`;
}

export function triggerName(childTable: string, event: "ins" | "upd"): string {
  return `${childTable}_${event}`;
}

function assertCollectionId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid collection id ${id}`);
}

/**
 * Quote an identifier for interpolation into SQL. Only accepts names the
 * sanitizer could have produced; anything else is a programming error, not
 * user input, and throws.
 */
export function ident(name: string): SQL {
  if (!SAFE_IDENTIFIER_RE.test(name) || name.length > PG_MAX_IDENTIFIER) {
    throw new Error(`Unsafe SQL identifier '${name}'`);
  }
  return sql.raw(`"${name}"`);
}

/**
 * A sanitized identifier as a single-quoted string literal, for the places
 * DDL needs a name as a value (trigger arguments). Same guard as ident().
 */
export function identLiteral(name: string): SQL {
  if (!SAFE_IDENTIFIER_RE.test(name) || name.length > PG_MAX_IDENTIFIER) {
    throw new Error(`Unsafe SQL identifier '${name}'`);
  }
  return sql.raw(`'${name}'`);
}

const STRICT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD string that is a real calendar date (what hc_safe_date accepts). */
export function isStrictDate(value: unknown): value is string {
  if (typeof value !== "string" || !STRICT_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Whether a JSON value lands in a projection column of `type` (else the column is NULL). */
export function valueFitsType(type: ProjectionType, value: unknown): boolean {
  switch (type) {
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "text": return typeof value === "string";
    case "date": return isStrictDate(value);
  }
}

/** The Postgres column type a projection type is stored as. */
export function pgType(type: ProjectionType): string {
  switch (type) {
    case "number": return "float8";
    case "boolean": return "boolean";
    case "date": return "date";
    default: return "text";
  }
}

/** The projection of a top-level key. */
export function findProjection(registry: StorageRegistry, field: string): Projection | undefined {
  return registry.projections.find((p) => !p.path && p.field === field);
}

/** The projection of a nested object path (two or more segments). */
export function findPathProjection(registry: StorageRegistry, segments: string[]): Projection | undefined {
  if (segments.length < 2) return undefined;
  return registry.projections.find((p) => p.path !== undefined && p.path.length === segments.length && p.path.every((s, i) => s === segments[i]));
}

/** Identity of a projection's source: the top-level key, or the path. */
export function projectionKey(p: Pick<Projection, "field" | "path">): string {
  return JSON.stringify(p.path ?? [p.field]);
}

/** Segments a projection reads from the document. */
export function projectionSegments(p: Pick<Projection, "field" | "path">): string[] {
  return p.path ?? [p.field];
}

export function findUnwind(registry: StorageRegistry, path: string): Unwind | undefined {
  return registry.unwinds.find((u) => u.path === path);
}
