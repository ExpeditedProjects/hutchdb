/**
 * Vendor-neutral error-reporting seam. Core ships no reporter, so
 * reportError is a no-op unless a deployment installs one at startup
 * (e.g. Hutch Cloud wires Sentry in its instrumentation hook).
 *
 * Context is for low-cardinality identifiers only (tool name, org/user id).
 * Never pass tool arguments or record data — reporters may ship it offsite.
 */
export type ErrorContext = Record<string, string | number | boolean | undefined>;
export type ErrorReporter = (err: unknown, context: ErrorContext) => void;

let reporter: ErrorReporter | null = null;

export function setErrorReporter(fn: ErrorReporter | null): void {
  reporter = fn;
}

export function reportError(err: unknown, context: ErrorContext = {}): void {
  if (!reporter) return;
  try {
    reporter(err, context);
  } catch {
    // A broken reporter must never change the caller's behavior.
  }
}
