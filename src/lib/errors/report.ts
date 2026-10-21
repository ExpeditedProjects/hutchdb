/**
 * Vendor-neutral error-reporting seam. Core ships no reporter, so
 * reportError is a no-op unless a deployment installs one at startup
 * (e.g. Hutch Cloud installs one in its instrumentation hook).
 *
 * Context is for low-cardinality identifiers only (tool name, org/user id).
 * Never pass tool arguments or record data — reporters may ship it offsite.
 */
export type ErrorContext = Record<string, string | number | boolean | undefined>;
export type ErrorReporter = (err: unknown, context: ErrorContext) => void;

// Held on globalThis, not in module scope: bundlers can inline this module
// into several chunks (Next's instrumentation hook and each route), and a
// module-scoped variable would give each copy its own reporter.
const REPORTER_KEY = Symbol.for("hutch.errorReporter");
type ReporterHolder = { [REPORTER_KEY]?: ErrorReporter | null };

export function setErrorReporter(fn: ErrorReporter | null): void {
  (globalThis as ReporterHolder)[REPORTER_KEY] = fn;
}

export function reportError(err: unknown, context: ErrorContext = {}): void {
  const reporter = (globalThis as ReporterHolder)[REPORTER_KEY];
  if (!reporter) return;
  try {
    reporter(err, context);
  } catch {
    // A broken reporter must never change the caller's behavior.
  }
}
