export type ValidationError = { error: string; status: 400 };

/** True for plain objects only — rejects null, arrays, and primitives. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate that `value`, after trim, is non-empty and ≤ `max` characters.
 *
 * `label` is interpolated into the user-facing error message and MUST be a
 * hard-coded constant — never user-controlled — to avoid response injection.
 * The string-literal union enforces this at the type level.
 */
export type ValidationLabel = "Name" | "Option value" | "Email";

export function validateTrimmedLength(
  value: string,
  max: number,
  label: ValidationLabel,
): { value: string } | ValidationError {
  const trimmed = value.trim();
  if (!trimmed) return { error: `${label} cannot be empty`, status: 400 };
  if (trimmed.length > max) {
    return { error: `${label} must be ${max} characters or fewer`, status: 400 };
  }
  return { value: trimmed };
}
