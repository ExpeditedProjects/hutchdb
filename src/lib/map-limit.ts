/**
 * Map `items` through `fn` with at most `limit` calls in flight, resolving
 * to the results in input order (as a serial loop would). Used for
 * per-collection queries, so `limit` stays well under the pg pool size
 * (src/lib/db/index.ts, pg's default of 10): one request never takes
 * every connection. Rejects with the first error, after in-flight calls
 * settle; no new calls start once one has failed.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  const rejection = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (rejection) throw rejection.reason;
  return results;
}

/** Per-collection queries one request runs at once. */
export const COLLECTION_QUERY_CONCURRENCY = 4;
