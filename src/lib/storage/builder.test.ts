import { describe, it, expect } from 'vitest'
import { buildLockTimeoutMs, buildTimeoutMs, MAX_RETRY_DELAY_MS, RETRY_BASE_MS, retryDelayMs, staleBuildingMs } from './builder'
import { hasDueBuilds, isDue, isReady, readQueryRegistry, type IndexBuild } from './registry'

const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe('isDue', () => {
  it('pending is always due; ready never', () => {
    expect(isDue({ state: 'pending', at: iso(0) }, NOW)).toBe(true)
    expect(isDue({ state: 'ready', at: iso(0) }, NOW)).toBe(false)
    expect(isDue(undefined, NOW)).toBe(false)
  })

  it('failed is due once retry_after has passed, or right away with retryFailed', () => {
    const failed: IndexBuild = { state: 'failed', at: iso(-1000), attempts: 1, error: 'x', retry_after: iso(60_000) }
    expect(isDue(failed, NOW)).toBe(false)
    expect(isDue(failed, NOW + 60_000)).toBe(true)
    expect(isDue(failed, NOW, { retryFailed: true })).toBe(true)
    // No (or an unreadable) retry time: due.
    expect(isDue({ state: 'failed', at: iso(0) }, NOW)).toBe(true)
  })

  it('building is due only once it is older than the staleness limit given', () => {
    const building: IndexBuild = { state: 'building', at: iso(-5000) }
    expect(isDue(building, NOW)).toBe(false)
    expect(isDue(building, NOW, { staleBuildingMs: 10_000 })).toBe(false)
    expect(isDue(building, NOW, { staleBuildingMs: 5000 })).toBe(true)
    expect(isDue(building, NOW, { staleBuildingMs: 0 })).toBe(true)
  })
})

describe('readQueryRegistry', () => {
  const pending: IndexBuild = { state: 'pending', at: iso(0) }
  const ready: IndexBuild = { state: 'ready', at: iso(0) }
  const raw = {
    projections: [
      { field: 'legacy', column: 'p_legacy', type: 'number', reason: 'r' },
      { field: 'built', column: 'p_built', type: 'text', reason: 'r', kind: 'expression', build: ready },
      { field: 'queued', column: 'p_queued', type: 'text', reason: 'r', kind: 'expression', build: pending },
      { field: 'broken', column: 'p_broken', type: 'text', reason: 'r', kind: 'expression', build: { state: 'failed', at: iso(0) } },
    ],
    unwinds: [
      { path: 'old', table: 'hc_1__old', fields: [], reason: 'r' },
      { path: 'new', table: 'hc_1__new', fields: [], reason: 'r', build: { state: 'building', at: iso(0) } },
    ],
    evaluated_rows: 5,
    search_index: { build: pending, reason: 'r' },
  }

  it('keeps only what can serve queries: legacy entries and ready builds', () => {
    const q = readQueryRegistry(raw)
    expect(q.projections.map((p) => p.field)).toEqual(['legacy', 'built'])
    expect(q.unwinds.map((u) => u.path)).toEqual(['old'])
    expect(q.search_index).toBeUndefined()
    expect(readQueryRegistry({ ...raw, search_index: { build: ready, reason: 'r' } }).search_index?.build.state).toBe('ready')
    expect(isReady({})).toBe(true)
  })

  it('hasDueBuilds sees pending work anywhere in the registry', () => {
    expect(hasDueBuilds(readQueryRegistry(raw), NOW)).toBe(false)
    expect(hasDueBuilds({ projections: [], unwinds: [], evaluated_rows: 0, search_index: { build: pending, reason: 'r' } }, NOW)).toBe(true)
  })

  it('drops the old failed_ddl list (its entries are re-queued by inference)', () => {
    expect(readQueryRegistry({ ...raw, failed_ddl: [{ kind: 'projection', key: '["x"]', at: iso(0) }] })).not.toHaveProperty('failed_ddl')
  })
})

describe('builder settings', () => {
  it('retry delays grow by 4x from a minute up to an hour', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([RETRY_BASE_MS, 4 * RETRY_BASE_MS, 16 * RETRY_BASE_MS, MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS])
  })

  it('timeouts come from the environment with safe defaults', () => {
    expect(buildTimeoutMs({})).toBe(600_000)
    expect(buildTimeoutMs({ HUTCH_INDEX_BUILD_TIMEOUT_MS: '30000' })).toBe(30_000)
    expect(buildTimeoutMs({ HUTCH_INDEX_BUILD_TIMEOUT_MS: 'nope' })).toBe(600_000)
    expect(buildTimeoutMs({ HUTCH_INDEX_BUILD_TIMEOUT_MS: '0' })).toBe(600_000)
    expect(buildLockTimeoutMs({})).toBe(1500)
    expect(staleBuildingMs({ HUTCH_INDEX_BUILD_TIMEOUT_MS: '1000' })).toBe(61_000)
  })
})
