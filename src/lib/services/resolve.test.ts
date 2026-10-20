import { describe, it, expect, vi, beforeEach } from 'vitest'

const { dbExecute } = vi.hoisted(() => ({ dbExecute: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { execute: dbExecute } }))
vi.mock('@/lib/db/queries', async () => {
  const { sql } = await import('drizzle-orm')
  return { findAccessibleCollectionBySlug: vi.fn(), collectionVisibleTo: vi.fn((userId: string) => sql`visible_to(${userId})`) }
})

import { findAccessibleCollection } from './resolve'
import { findAccessibleCollectionBySlug } from '@/lib/db/queries'

const access = (slug: string, name: string) => ({ collection: { slug, name }, role: 'owner', organization: {} }) as never

describe('findAccessibleCollection', () => {
  beforeEach(() => {
    vi.mocked(findAccessibleCollectionBySlug).mockReset()
    dbExecute.mockReset()
  })

  it('returns the slug match without a name lookup', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(access('tags-dfaaa941', 'Tags'))
    expect(await findAccessibleCollection('tags-dfaaa941', 'u')).toMatchObject({ collection: { slug: 'tags-dfaaa941' } })
    expect(dbExecute).not.toHaveBeenCalled()
  })

  it('falls back to the name, as store resolves it ("tags" finds "Tags")', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockImplementation(async (slug) => (slug === 'tags-dfaaa941' ? access('tags-dfaaa941', 'Tags') : undefined))
    dbExecute.mockResolvedValue({ rows: [{ slug: 'tags-dfaaa941', name: 'Tags' }] })
    expect(await findAccessibleCollection('tags', 'u', 'owner')).toMatchObject({ collection: { slug: 'tags-dfaaa941' } })
    // The candidate names are bound parameters, lowercased.
    const query = dbExecute.mock.calls[0][0]
    expect(JSON.stringify(query)).toContain('"tags"')
    // Only collections the caller can see are candidates, so other users'
    // same-named collections never fill the candidate limit.
    expect(JSON.stringify(query)).toContain('visible_to(')
    expect(JSON.stringify(query)).toContain('"u"')
  })

  it('resolves nothing when two visible collections match equally', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockImplementation(async (slug) => (slug === 'tags' ? undefined : access(slug, 'x')))
    dbExecute.mockResolvedValue({ rows: [{ slug: 'tags-1', name: 'Tags' }, { slug: 'tags-2', name: 'TAGS' }] })
    expect(await findAccessibleCollection('tags', 'u')).toBeUndefined()
  })

  it('prefers the one exact-case name over case-insensitive ones', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockImplementation(async (slug) => (slug === 'Tags' ? undefined : access(slug, 'x')))
    dbExecute.mockResolvedValue({ rows: [{ slug: 'tags-1', name: 'Tags' }, { slug: 'tags-2', name: 'tags' }] })
    expect(await findAccessibleCollection('Tags', 'u')).toMatchObject({ collection: { slug: 'tags-1' } })
  })

  it('ignores collections the user cannot see', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockImplementation(async (slug) => (slug === 'tags-mine' ? access('tags-mine', 'Tags') : undefined))
    dbExecute.mockResolvedValue({ rows: [{ slug: 'tags-theirs', name: 'Tags' }, { slug: 'tags-mine', name: 'Tags' }] })
    expect(await findAccessibleCollection('tags', 'u')).toMatchObject({ collection: { slug: 'tags-mine' } })
  })

  it('needs the requested role on the resolved collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockImplementation(async (slug, _u, role) => (slug === 'tags-1' && role === 'viewer' ? access('tags-1', 'Tags') : undefined))
    dbExecute.mockResolvedValue({ rows: [{ slug: 'tags-1', name: 'Tags' }] })
    expect(await findAccessibleCollection('tags', 'u', 'owner')).toBeUndefined()
  })
})
