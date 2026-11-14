// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Drizzle applies only journal entries whose `when` is newer than the last
// applied migration, and Cloud adds its own migrations (numbered from 5000)
// to this journal, so a future-dated entry hides Cloud's (REVIEW.md, #77).

const DRIZZLE = fileURLToPath(new URL('../../../drizzle', import.meta.url))
type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
const journal = JSON.parse(readFileSync(`${DRIZZLE}/meta/_journal.json`, 'utf8')) as { entries: Entry[] }
const core = journal.entries.filter((e) => e.idx < 5000)

/** A migration's SQL statements, without comments. */
function statements(tag: string): string[] {
  return readFileSync(`${DRIZZLE}/${tag}.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^--.*$/gm, '').trim())
    .filter(Boolean)
}

describe('drizzle migration journal', () => {
  it('has a .sql file for every entry, numbered by its idx', () => {
    for (const e of journal.entries) {
      expect(existsSync(`${DRIZZLE}/${e.tag}.sql`), e.tag).toBe(true)
      expect(Number(e.tag.split('_')[0]), e.tag).toBe(e.idx)
    }
  })

  it('dates Core entries in idx order, and none in the future', () => {
    for (let i = 1; i < core.length; i++) expect(core[i].when, core[i].tag).toBeGreaterThan(core[i - 1].when)
    for (const e of journal.entries) expect(e.when, e.tag).toBeLessThanOrEqual(Date.now())
  })
})

describe('migration 0024_unpublish_views', () => {
  it('follows 0023 in the journal, dated the day it was written', () => {
    const at = core.findIndex((e) => e.tag === '0024_unpublish_views')
    expect(at).toBeGreaterThan(0)
    expect(core[at - 1].tag).toBe('0023_view_published')
    expect(core[at]).toEqual({ idx: 24, version: '7', when: Date.UTC(2026, 10, 12), tag: '0024_unpublish_views', breakpoints: true })
  })

  it('unpublishes every view and changes nothing else', () => {
    expect(statements('0024_unpublish_views')).toEqual(['UPDATE "views" SET "published" = false WHERE "published";'])
  })
})

describe('migration 0025_view_publisher', () => {
  it('follows 0024 in the journal, dated the day it was written', () => {
    const at = core.findIndex((e) => e.tag === '0025_view_publisher')
    expect(at).toBeGreaterThan(0)
    expect(core[at - 1].tag).toBe('0024_unpublish_views')
    expect(core[at]).toEqual({ idx: 25, version: '7', when: Date.UTC(2026, 10, 14), tag: '0025_view_publisher', breakpoints: true })
  })
})
