/**
 * Classifying Postgres failures for tool output. Driver errors carry SQL
 * text, bound params and internal table names (hc_12) and must never reach
 * a client verbatim (REVIEW.md); what an agent needs is what happened —
 * a timeout, a value of the wrong type — so it can change its request.
 *
 * drizzle wraps the node-postgres error (which has the SQLSTATE in `code`)
 * as `cause` of a DrizzleQueryError; other layers wrap it again (the
 * transform's TransformStepError), so the classifier walks the cause chain.
 */

import { DrizzleQueryError } from "drizzle-orm";

/** A Postgres error as node-postgres throws it: a SQLSTATE plus its message. */
export type PgErrorLike = { code: string; message: string };

export type DbErrorKind = "timeout" | "invalid_input" | "other";

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/** SQLSTATE 57014 query_canceled: statement_timeout (or a cancel request). */
const TIMEOUT_CODES = new Set(["57014"]);

/**
 * A value that doesn't fit the type it meets: bad text representation
 * (22P02), datetime format/field overflow (22007, 22008), numeric out of
 * range (22003), an invalid parameter value (22023), invalid JSON text
 * (22P05 untranslatable, 22032 invalid_json_text), and datatype mismatch
 * (42804).
 */
const INVALID_INPUT_CODES = new Set(["22P02", "22007", "22008", "22003", "22023", "22P05", "22032", "42804"]);

/** The first error in `err`'s cause chain that carries a SQLSTATE. */
export function findPgError(err: unknown): PgErrorLike | null {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE_RE.test(code)) {
      return { code, message: String((current as { message?: unknown }).message ?? "") };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Database-layer failures whose messages leak driver internals (SQL text,
 * bound params, table names) and must never reach a client verbatim.
 *
 * drizzle-orm 0.45 throws DrizzleQueryError with message
 * "Failed query: <sql>\nparams: <params>". The class never assigns
 * `this.name`, so at runtime `err.name` is plain "Error" — the instanceof
 * and message checks are the ones that actually fire; the name check is
 * kept for errors crossing realm/bundle boundaries where instanceof fails.
 * A node-postgres error (SQLSTATE in `code`) thrown without drizzle's
 * wrapper counts too: its message can name tables.
 */
export function isDatabaseError(err: unknown): boolean {
  if (err instanceof DrizzleQueryError) return true;
  if (!(err instanceof Error)) return false;
  if (findPgError(err)) return true;
  return err.name === "DrizzleQueryError" || /^Failed query/i.test(err.message);
}

export function classifyDbError(err: unknown): DbErrorKind {
  const pg = findPgError(err);
  if (!pg) return "other";
  if (TIMEOUT_CODES.has(pg.code)) return "timeout";
  if (INVALID_INPUT_CODES.has(pg.code)) return "invalid_input";
  return "other";
}

export function isStatementTimeout(err: unknown): boolean {
  return classifyDbError(err) === "timeout";
}

/**
 * The per-statement timeout requests run under, in ms. Mirrors the pool's
 * setting in src/lib/db/index.ts (HUTCH_DB_STATEMENT_TIMEOUT_MS, default
 * 5000); read here rather than imported so this module never builds a pool.
 */
export function statementTimeoutMs(): number {
  const raw = Number(process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS ?? 5000);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/** "5s", "2.5s", "800ms". */
export function formatTimeout(ms = statementTimeoutMs()): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

/**
 * The Postgres type named in an invalid-input message ("invalid input
 * syntax for type integer: ..." → "integer"), when it names a plain
 * built-in type. Never the value or any identifier.
 */
function expectedType(message: string): string | null {
  const m = /\bfor type ([a-z][a-z ]{1,40}?)(?::|$)/.exec(message);
  return m ? m[1].trim() : null;
}

export type DbErrorContext = {
  /** The tool (or operation) that failed, e.g. "hutch_query_records". */
  tool: string;
  /** The collection the caller named, echoed back as they wrote it. */
  collection?: string;
  /** Extra sentence(s) appended to a timeout message (e.g. index state). */
  timeoutHint?: string;
  /** The operation writes: a timeout gets batching advice instead of query advice. */
  write?: boolean;
  /** The tool's arguments, for advice that fits what was asked (a grouped query vs a page of records). */
  args?: Record<string, unknown>;
};

/** Points at the index list, for advice to filter on an indexed field. */
const INDEXED_FIELDS = "ideally on an indexed field (hutch_describe_collection lists them under storage.indexes)";

/** Read-only tools: heavy requests run side by side slow each other down. */
const ONE_AT_A_TIME = "Several heavy requests at once slow each other down, so run them one at a time.";

/**
 * What to change after a read timed out, in terms of the inputs the tool
 * actually takes. Never claims a retry is bound to fail: the same request
 * can succeed once concurrent load is gone.
 */
export function timeoutAdvice(tool: string, args: Record<string, unknown> = {}): string {
  const has = (key: string) => args[key] !== undefined && args[key] !== null;
  switch (tool) {
    case "hutch_query_records":
      if (has("group_by") || has("aggregate") || has("time_bucket")) {
        return `Grouped and aggregate queries read every record the filter matches: add or narrow a filter, ${INDEXED_FIELDS}, or ask for fewer aggregates per call. ${ONE_AT_A_TIME}`;
      }
      return `Narrow the filter, ${INDEXED_FIELDS}, use limit: 0 to count instead of fetching, or request fewer fields; $contains, and search on a collection whose full-text index is not ready, read every document. ${ONE_AT_A_TIME}`;
    case "hutch_export_records":
      return `Narrow the filter, ${INDEXED_FIELDS}, or export fewer records (limit) or fields per call; $contains, and search on a collection whose full-text index is not ready, read every document. ${ONE_AT_A_TIME}`;
    case "hutch_search":
      return `hutch_search looks in every collection; to search one collection, use hutch_query_records with search (plus a filter to narrow it). ${ONE_AT_A_TIME}`;
    case "hutch_describe_collection":
      return `To see the fields another way, fetch a few records with hutch_query_records (limit: 2, max_string_length: 200), or call hutch_collection_stats for field fill rates. ${ONE_AT_A_TIME}`;
    case "hutch_collection_stats":
      return `For the record count alone use hutch_query_records with limit: 0; hutch_describe_collection lists the fields from a sample. ${ONE_AT_A_TIME}`;
    default:
      return "This reads little data, so the database was busy or a table was locked (for example by an index build); the same request may succeed when the server is less busy.";
  }
}

/**
 * Client-safe text for a database failure: what happened, and what to
 * change. Contains no SQL, params, table names or connection details —
 * only the tool name, the collection name the caller passed, the timeout,
 * and (for invalid input) the Postgres type name.
 */
export function describeDbError(err: unknown, ctx: DbErrorContext): string {
  const kind = classifyDbError(err);
  const on = ctx.collection ? ` on collection '${ctx.collection}'` : "";
  if (kind === "timeout") {
    const hint = ctx.timeoutHint ? ` ${ctx.timeoutHint}` : "";
    const advice = ctx.write
      ? "Send smaller batches or touch fewer records per call, and check what was saved (hutch_query_records with limit: 0 counts) before retrying."
      : timeoutAdvice(ctx.tool, ctx.args);
    return `${ctx.tool} timed out after ${formatTimeout()}${on}. ${advice}${hint}`;
  }
  if (kind === "invalid_input") {
    const type = expectedType(findPgError(err)?.message ?? "");
    const expected = type ? ` (expected ${type})` : "";
    return `${ctx.tool} failed${on}: a value in the request does not match the type of the field or column it is used with${expected}. Check the values' types: dates as ISO strings (created_after/created_before take ISO dates), numbers as numbers.`;
  }
  return `${ctx.tool} failed while accessing the database. Try again or adjust the inputs.`;
}
