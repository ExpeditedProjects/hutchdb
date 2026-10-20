import { AsyncLocalStorage } from "node:async_hooks";
import { envInt } from "@/lib/constants";
import { buildPendingIndexes, buildTimeoutMs, staleBuildingMs } from "./builder";
import { hasDueBuilds, readRegistry } from "./registry";

/**
 * Collections with build work, collected while one request runs, built
 * after its response is sent. The MCP route opens the queue and hands the
 * drain to next/server after(); anywhere else (scripts, tests, Cloud code
 * paths without the wrapper) there is no queue, queueing is a no-op, and
 * the work stays pending for the next request, `npm run
 * storage:build-indexes` or the cutover.
 */
const queue = new AsyncLocalStorage<Set<number>>();

/**
 * Process-wide: collections drains handed over that no builder has taken
 * yet, and how many builder loops are running. Each builder holds a pool
 * connection for as long as its builds take (minutes on a large table), so
 * concurrent requests must not each start one: at most
 * indexBuildConcurrency() loops run, and a drain that finds them all busy
 * leaves its collections here for a running loop to take.
 */
const waiting = new Set<number>();
let runningBuilders = 0;

/** Builder loops one process runs at once (HUTCH_INDEX_BUILD_CONCURRENCY, default 1). */
export function indexBuildConcurrency(env: Record<string, string | undefined> = process.env): number {
  return envInt("HUTCH_INDEX_BUILD_CONCURRENCY", 1, { env });
}

/** Default after() build budget on Vercel: under the 300 s default function duration that cuts after() work off. */
export const DEFAULT_VERCEL_AFTER_BUILD_BUDGET_MS = 240_000;

/**
 * How long builds started from after() may run in all, or undefined for no
 * platform limit: HUTCH_AFTER_BUILD_BUDGET_MS, else 240 s on Vercel
 * (process.env.VERCEL), else none (each build gets
 * HUTCH_INDEX_BUILD_TIMEOUT_MS, as from the CLI).
 */
export function afterBuildBudgetMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const fallback = env.VERCEL ? DEFAULT_VERCEL_AFTER_BUILD_BUDGET_MS : undefined;
  const n = envInt("HUTCH_AFTER_BUILD_BUDGET_MS", -1, { env });
  return n > 0 ? n : fallback;
}

/**
 * Run `fn` with a build queue open. `fn` receives the drain: a function
 * that hands every collection queued so far to the process's builder
 * (starting it when fewer than indexBuildConcurrency() loops run, else
 * returning at once and leaving them to the running one), logging, never
 * throwing, failures. Call it once the response is done.
 */
export function withIndexBuildQueue<T>(fn: (drain: () => Promise<void>) => T): T {
  const ids = new Set<number>();
  const drain = async () => {
    for (const id of ids) waiting.add(id);
    ids.clear();
    await runBuilder();
  };
  return queue.run(ids, () => fn(drain));
}

/**
 * Build waiting collections one after another until none is left or the
 * after() budget is spent; what is left then stays waiting (and pending in
 * its registry) for the next drain.
 */
async function runBuilder(): Promise<void> {
  if (runningBuilders >= indexBuildConcurrency()) return;
  runningBuilders++;
  try {
    const budget = afterBuildBudgetMs();
    const end = budget === undefined ? Number.POSITIVE_INFINITY : Date.now() + budget;
    for (;;) {
      const next = waiting.values().next();
      if (next.done) break;
      const left = end - Date.now();
      if (left <= 0) break;
      const collectionId = next.value;
      waiting.delete(collectionId);
      try {
        await buildPendingIndexes(budget === undefined ? { collectionId, budgetMs: buildTimeoutMs() } : { collectionId, budgetMs: left, platformBudgetMs: left });
      } catch (err) {
        console.error(`[storage] background index build failed to run for collection ${collectionId}`, err);
      }
    }
  } finally {
    runningBuilders--;
  }
}

/** Queue a build for the collection when a queue is open. Returns whether it was queued. */
export function queueIndexBuild(collectionId: number): boolean {
  const ids = queue.getStore();
  if (!ids) return false;
  ids.add(collectionId);
  return true;
}

/**
 * Queue a build when the collection's registry (as already loaded, no
 * query) has due work: something pending, a failed build past its backoff,
 * or a build whose builder died (building for longer than any build may
 * run). Writes call it after inference queued work; reads call it too, so
 * work lost to a restart is picked up by the next request that touches the
 * collection, not only by its next write. A builder already at work holds
 * the collection's lock, and the queued run skips it.
 */
export function queueDueIndexBuild(collection: { id: number; storage: unknown }): boolean {
  if (!hasDueBuilds(readRegistry(collection.storage), Date.now(), { staleBuildingMs: staleBuildingMs() })) return false;
  return queueIndexBuild(collection.id);
}
