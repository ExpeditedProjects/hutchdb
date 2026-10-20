/**
 * Size limits for records returned to an agent (hutch_query_records,
 * hutch_search). Two records of a long-form collection came to 128K
 * characters and a default orders page to about 1 MB, more than a client
 * accepts. Export never goes through here: it stays lossless.
 */

/** Strings longer than this are cut by default; max_string_length: 0 turns the cap off. */
export const DEFAULT_MAX_STRING_LENGTH = 2000;

/** A query page whose records serialize to more than this is cut short (has_more/next_offset continue it). */
export const MAX_PAGE_CHARS = 200_000;

export type OutputLimits = {
  /** Cut strings longer than this many characters; 0 means no cap. */
  maxStringLength?: number;
  /** Cut a page's rows to fit this many characters of JSON; at least one row is always returned. */
  maxPageChars?: number;
};

export function truncationMarker(remaining: number): string {
  return `…[truncated: ${remaining} more chars; pass max_string_length: 0 for full values]`;
}

/**
 * `value` with every string longer than `max` cut to `max` characters plus
 * a marker saying how many were cut, at any depth (object keys untouched),
 * and how many strings were cut. max <= 0 returns the value unchanged.
 */
export function truncateStrings<T>(value: T, max: number): { value: T; truncated: number } {
  if (!(max > 0)) return { value, truncated: 0 };
  let truncated = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= max) return v;
      truncated++;
      // Never split a surrogate pair.
      const cut = /[\uD800-\uDBFF]/.test(v[max - 1]) ? max - 1 : max;
      return v.slice(0, cut) + truncationMarker(v.length - cut);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  const result = walk(value) as T;
  return { value: result, truncated };
}

/** How many leading rows fit in `budget` characters of JSON (at least one when there are any). */
export function rowsThatFit(rows: unknown[], budget: number): number {
  let used = 2;
  for (let i = 0; i < rows.length; i++) {
    used += JSON.stringify(rows[i]).length + 1;
    if (used > budget) return Math.max(1, i);
  }
  return rows.length;
}

type Page = { total: number; count: number; offset: number; has_more: boolean; next_offset: number | null };

/**
 * A query result (records or aggregate rows) with long strings cut and its
 * rows cut short to fit the page budget. A cut page keeps paging exact:
 * count, has_more and next_offset describe the rows actually returned, so
 * following next_offset continues with the first row left out.
 */
export function limitQueryOutput<R extends Page & { records?: unknown[]; results?: unknown[] }>(result: R, limits: OutputLimits): R & { truncated_strings?: number; page_note?: string } {
  const key = Array.isArray(result.records) ? "records" : Array.isArray(result.results) ? "results" : null;
  if (!key) return result;
  const { value: rows, truncated } = truncateStrings(result[key] as unknown[], limits.maxStringLength ?? 0);
  let out: R & { truncated_strings?: number; page_note?: string } = { ...result, [key]: rows };
  if (truncated > 0) out.truncated_strings = truncated;

  const budget = limits.maxPageChars;
  if (budget && budget > 0 && rows.length > 1) {
    const keep = rowsThatFit(rows, budget);
    if (keep < rows.length) {
      const nextOffset = result.offset + keep;
      out = {
        ...out,
        [key]: rows.slice(0, keep),
        count: keep,
        has_more: nextOffset < result.total,
        next_offset: nextOffset < result.total ? nextOffset : null,
        page_note: `Returned ${keep} of the ${rows.length} ${key} this page would hold, to keep the response under ${budget.toLocaleString("en-US")} characters. Continue with offset: ${nextOffset}, or request fewer fields${limits.maxStringLength === 0 ? " or a max_string_length" : " or a lower max_string_length"} to get more per page.`,
      };
    }
  }
  return out;
}
