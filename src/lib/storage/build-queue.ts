import { AsyncLocalStorage } from "node:async_hooks";
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
 * Run `fn` with a build queue open. `fn` receives the drain: a function
 * that builds every collection queued so far, one after another, logging
 * (never throwing) failures. Call it once the response is done.
 */
export function withIndexBuildQueue<T>(fn: (drain: () => Promise<void>) => T): T {
  const ids = new Set<number>();
  const drain = async () => {
    const pending = [...ids];
    ids.clear();
    for (const collectionId of pending) {
      try {
        await buildPendingIndexes({ collectionId, budgetMs: buildTimeoutMs() });
      } catch (err) {
        console.error(`[storage] background index build failed to run for collection ${collectionId}`, err);
      }
    }
  };
  return queue.run(ids, () => fn(drain));
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
