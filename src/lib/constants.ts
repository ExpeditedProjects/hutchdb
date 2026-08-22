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

// File storage tiers — inline content lives inside the record JSON (so it must
// stay under MAX_RECORD_SIZE); anything bigger or binary goes to blob storage.
export const MAX_INLINE_FILE_SIZE = 262_144; // 256KB — inline (in-record) file content cap
export const MAX_FILE_SIZE = 4_194_304; // 4MB — overall file size cap (blob tier)

export const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/;
export const MAX_FIELD_NAME_LENGTH = 64;
