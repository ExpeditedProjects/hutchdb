export const RECORD_STATUSES = ["active", "pending", "flagged", "archived"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export const DEFAULT_RECORD_STATUS: RecordStatus = "active";

// Type detection regex patterns — shared between schema-inference (server) and SmartCell (client)
export const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|avif|bmp|ico)(\?.*)?$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}($|T|\s)/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const URL_RE = /^https?:\/\//;

export const REINFER_COOLDOWN_MS = 60_000; // skip re-inference if inferred within last 60s

export const SIDEBAR_COLLECTION_LIMIT = 10;

export const MAX_RECORD_SIZE = 1_000_000; // 1MB — enforced at the route and service layers

export const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/;
export const MAX_FIELD_NAME_LENGTH = 64;

export const DEFAULT_MCP_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Upper bound on an MCP request body (hutch_store_records /
 * hutch_import_records payloads): HUTCH_MCP_MAX_BODY_BYTES when it is a
 * positive whole number of bytes, else 16 MiB. A host with a smaller
 * platform cap (Vercel's 4.5 MB) sets it below that cap.
 */
export function mcpMaxRequestBodyBytes(env: Record<string, string | undefined> = process.env): number {
  return envInt("HUTCH_MCP_MAX_BODY_BYTES", DEFAULT_MCP_MAX_REQUEST_BODY_BYTES, { env });
}

/**
 * A whole-number setting from the environment: `name` when it is set to an
 * integer of at least `min` (default 1), else `fallback` (unset, empty,
 * not a whole number, or below `min`).
 */
export function envInt(name: string, fallback: number, { min = 1, env = process.env }: { min?: number; env?: Record<string, string | undefined> } = {}): number {
  const raw = env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** "16 MB" for 16 MiB, "4 MB" for 4 MiB, "512 KB" or "4.5 MB" otherwise, as the tool descriptions state it. */
export function formatBodyLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${Number.isInteger(mib) ? mib : Math.round(mib * 10) / 10} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const MCP_MAX_REQUEST_BODY_BYTES = mcpMaxRequestBodyBytes();
export const MCP_MAX_REQUEST_BODY_LABEL = formatBodyLimit(MCP_MAX_REQUEST_BODY_BYTES);
