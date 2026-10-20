import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { buildMock } = vi.hoisted(() => ({ buildMock: vi.fn() }))

vi.mock('./builder', () => ({
  buildPendingIndexes: buildMock,
  buildTimeoutMs: () => 600_000,
  staleBuildingMs: () => 660_000,
}))

import { afterBuildBudgetMs, indexBuildConcurrency, queueIndexBuild, withIndexBuildQueue } from './build-queue'

/** A build that stays in flight until release(id) is called. */
function controllableBuilds() {
  const inFlight = new Set<number>()
  let maxInFlight = 0
  const releases = new Map<number, () => void>()
  const started: number[] = []
  buildMock.mockImplementation(async ({ collectionId }: { collectionId: number }) => {
    started.push(collectionId)
    inFlight.add(collectionId)
    maxInFlight = Math.max(maxInFlight, inFlight.size)
    await new Promise<void>((resolve) => releases.set(collectionId, resolve))
    inFlight.delete(collectionId)
    return { collections: [], failed: 0 }
  })
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1))
    expect(cond()).toBe(true)
  }
  return {
    started,
    get maxInFlight() { return maxInFlight },
    release: async (id: number) => {
      await waitFor(() => releases.has(id))
      releases.get(id)!()
      releases.delete(id)
    },
    waitFor,
  }
}

/** Open a queue, queue `ids` in it, and return its drain (as the route does with after()). */
function requestQueueing(ids: number[]): () => Promise<void> {
  return withIndexBuildQueue((drain) => {
    for (const id of ids) queueIndexBuild(id)
    return drain
  })
}

beforeEach(() => {
  buildMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('process-wide single-flight builder', () => {
  it('a drain that finds a builder running hands its collections to it and returns; builds never overlap', async () => {
    const builds = controllableBuilds()
    const first = requestQueueing([1])()
    await builds.waitFor(() => builds.started.length === 1)

    // A second request's drain while the first builder is busy: it returns at once.
    let secondDone = false
    const second = requestQueueing([2, 1])().then(() => { secondDone = true })
    await second
    expect(secondDone).toBe(true)
    expect(builds.started).toEqual([1])

    // The running builder takes the merged collections after its current one.
    await builds.release(1)
    await builds.waitFor(() => builds.started.length === 2)
    await builds.release(2)
    await builds.waitFor(() => builds.started.length === 3)
    // 1 again: the second request queued it after the first build had read its registry.
    expect(builds.started).toEqual([1, 2, 1])
    await builds.release(1)
    await first
    expect(builds.maxInFlight).toBe(1)
    expect(buildMock).toHaveBeenCalledTimes(3)
  })

  it('HUTCH_INDEX_BUILD_CONCURRENCY=2 lets two builders run at once', async () => {
    vi.stubEnv('HUTCH_INDEX_BUILD_CONCURRENCY', '2')
    const builds = controllableBuilds()
    const a = requestQueueing([1])()
    const b = requestQueueing([2])()
    await builds.waitFor(() => builds.started.length === 2)
    expect(builds.maxInFlight).toBe(2)
    await builds.release(1)
    await builds.release(2)
    await Promise.all([a, b])
  })

  it('a later drain starts a builder again once the previous one finished', async () => {
    buildMock.mockResolvedValue({ collections: [], failed: 0 })
    await requestQueueing([1])()
    await requestQueueing([2])()
    expect(buildMock.mock.calls.map(([o]) => o.collectionId)).toEqual([1, 2])
  })

  it('without a platform budget each collection gets the full build timeout; with one, the rest of the budget as a hard limit', async () => {
    buildMock.mockResolvedValue({ collections: [], failed: 0 })
    await requestQueueing([1])()
    expect(buildMock.mock.calls[0][0]).toEqual({ collectionId: 1, budgetMs: 600_000 })

    vi.stubEnv('HUTCH_AFTER_BUILD_BUDGET_MS', '5000')
    await requestQueueing([2])()
    const opts = buildMock.mock.calls[1][0]
    expect(opts.collectionId).toBe(2)
    expect(opts.platformBudgetMs).toBeGreaterThan(4000)
    expect(opts.platformBudgetMs).toBeLessThanOrEqual(5000)
    expect(opts.budgetMs).toBe(opts.platformBudgetMs)
  })

  it('stops starting builds once the platform budget is spent, leaving the rest for the next drain', async () => {
    vi.stubEnv('HUTCH_AFTER_BUILD_BUDGET_MS', '30')
    buildMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40))
      return { collections: [], failed: 0 }
    })
    await requestQueueing([1, 2])()
    expect(buildMock.mock.calls.map(([o]) => o.collectionId)).toEqual([1])
    vi.stubEnv('HUTCH_AFTER_BUILD_BUDGET_MS', '')
    buildMock.mockResolvedValue({ collections: [], failed: 0 })
    await requestQueueing([3])()
    expect(buildMock.mock.calls.map(([o]) => o.collectionId)).toEqual([1, 2, 3])
  })
})

describe('build settings', () => {
  it('concurrency defaults to 1', () => {
    expect(indexBuildConcurrency({})).toBe(1)
    expect(indexBuildConcurrency({ HUTCH_INDEX_BUILD_CONCURRENCY: '3' })).toBe(3)
    expect(indexBuildConcurrency({ HUTCH_INDEX_BUILD_CONCURRENCY: '0' })).toBe(1)
  })

  it('the after() budget is 240 s on Vercel, unset elsewhere, and HUTCH_AFTER_BUILD_BUDGET_MS overrides both', () => {
    expect(afterBuildBudgetMs({})).toBeUndefined()
    expect(afterBuildBudgetMs({ VERCEL: '1' })).toBe(240_000)
    expect(afterBuildBudgetMs({ VERCEL: '1', HUTCH_AFTER_BUILD_BUDGET_MS: '60000' })).toBe(60_000)
    expect(afterBuildBudgetMs({ HUTCH_AFTER_BUILD_BUDGET_MS: '60000' })).toBe(60_000)
    expect(afterBuildBudgetMs({ HUTCH_AFTER_BUILD_BUDGET_MS: 'nope' })).toBeUndefined()
  })
})
