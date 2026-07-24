import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertReturning = vi.fn()
const updateReturning = vi.fn()
const selectLimit = vi.fn()

vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: insertReturning })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: selectLimit })),
          })),
          where: vi.fn(() => ({ limit: selectLimit })),
        })),
      })),
    })),
  },
}))

vi.mock('@/lib/db/queries', () => ({
  findAccessibleCollectionBySlug: vi.fn(),
}))

vi.mock('@/lib/revalidation', () => ({
  revalidateDashboard: vi.fn(),
}))

import { createView, renameView, seedAutoViews } from './views'
import { findAccessibleCollectionBySlug } from '@/lib/db/queries'
import { db } from '@/lib/db'

const collectionRow = {
  id: 42,
  apiKeyId: 1,
  organizationId: 'org-test',
  name: 'Bookmarks',
  slug: 'bookmarks',
  description: null,
  schema: null,
  uniqueKey: null,
  published: false,
  publishedAt: null,
  visibility: 'private',
  orgDefaultRole: 'viewer',
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockOrg = {
  id: 'org-test',
  slug: 'test',
  name: 'Test',
  personal: false,
  callerRole: 'admin' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createView', () => {
  it('returns null when the collection is not accessible to the api key', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await createView('bookmarks', 'user-test', { type: 'kanban' })
    expect(result).toBeNull()
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('defaults the name to the title-cased view type', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Kanban', slug: 'kanban-abc12345', type: 'kanban' }])

    await createView('bookmarks', 'user-test', { type: 'kanban' })

    const valuesCall = vi.mocked(db.insert).mock.results[0].value.values
    const inserted = valuesCall.mock.calls[0][0]
    expect(inserted.name).toBe('Kanban')
    expect(inserted.type).toBe('kanban')
  })

  it('defaults the type to "table" and names the view "Table"', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Table', slug: 'table-xxxxxxxx', type: 'table' }])

    await createView('bookmarks', 'user-test', {})

    const valuesCall = vi.mocked(db.insert).mock.results[0].value.values
    const inserted = valuesCall.mock.calls[0][0]
    expect(inserted.name).toBe('Table')
    expect(inserted.type).toBe('table')
  })

  it('uses uniqueSlug so two views of the same type do not collide', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Table', slug: 'table-aaaaaaaa', type: 'table' }])

    await createView('bookmarks', 'user-test', { type: 'table' })
    await createView('bookmarks', 'user-test', { type: 'table' })

    const slugs = vi.mocked(db.insert).mock.results.map((r) => {
      const inserted = r.value.values.mock.calls[0][0]
      return inserted.slug
    })
    expect(slugs).toHaveLength(2)
    // Both slugs share the "table-" prefix but are not equal.
    expect(slugs[0]).toMatch(/^table-[0-9a-f]{8}$/)
    expect(slugs[1]).toMatch(/^table-[0-9a-f]{8}$/)
    expect(slugs[0]).not.toBe(slugs[1])
  })
})

describe('createView with explicit name and groupBy', () => {
  it('uses an explicit name (after trim) instead of the type-derived default', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'My Board', slug: 'my-board-aaaaaaaa', type: 'kanban' }])

    await createView('bookmarks', 'user-test', { type: 'kanban', name: '  My Board  ' } as never)

    const valuesCall = vi.mocked(db.insert).mock.results[0].value.values
    const inserted = valuesCall.mock.calls[0][0]
    expect(inserted.name).toBe('My Board')
  })

  it('rejects whitespace-only names with status 400 and does not insert', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })

    const result = await createView('bookmarks', 'user-test', { type: 'table', name: '   ' } as never)

    expect(result).toEqual(expect.objectContaining({ error: expect.any(String), status: 400 }))
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('rejects names longer than 100 characters with status 400 and does not insert', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })

    const result = await createView('bookmarks', 'user-test', { type: 'table', name: 'x'.repeat(101) } as never)

    expect(result).toEqual(expect.objectContaining({ status: 400 }))
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('writes groupBy into config.groupByField on the inserted view', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Kanban', slug: 'kanban-aaaaaaaa', type: 'kanban' }])

    await createView('bookmarks', 'user-test', { type: 'kanban', groupBy: 'status' } as never)

    const valuesCall = vi.mocked(db.insert).mock.results[0].value.values
    const inserted = valuesCall.mock.calls[0][0]
    expect(inserted.config).toEqual(expect.objectContaining({ groupByField: 'status' }))
  })

  it('merges groupBy into a caller-supplied config without clobbering other keys', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Kanban', slug: 'kanban-aaaaaaaa', type: 'kanban' }])

    await createView('bookmarks', 'user-test', {
      type: 'kanban',
      groupBy: 'status',
      config: { color: 'blue', cardSize: 'lg' },
    } as never)

    const valuesCall = vi.mocked(db.insert).mock.results[0].value.values
    const inserted = valuesCall.mock.calls[0][0]
    expect(inserted.config).toEqual(expect.objectContaining({
      groupByField: 'status',
      color: 'blue',
      cardSize: 'lg',
    }))
  })
})

describe('renameView', () => {
  it('rejects empty names with status 400', async () => {
    const result = await renameView(1, 'user-test', '   ')
    expect(result).toEqual(expect.objectContaining({ error: expect.any(String), status: 400 }))
    expect(db.select).not.toHaveBeenCalled()
  })

  it('rejects names longer than 100 characters with status 400', async () => {
    const result = await renameView(1, 'user-test', 'x'.repeat(101))
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
    expect(db.select).not.toHaveBeenCalled()
  })

  it('returns 404 when the view is not owned by any of the supplied api keys', async () => {
    selectLimit.mockResolvedValue([])
    const result = await renameView(99, 'user-test', 'New Name')
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
    expect(db.update).not.toHaveBeenCalled()
  })

  it('trims whitespace and updates the name when the caller owns the view', async () => {
    selectLimit.mockResolvedValue([{ collectionId: 42, collectionSlug: 'bookmarks' }])
    updateReturning.mockResolvedValue([{ id: 7, name: 'Pretty Name', slug: 'table-aaaaaaaa', type: 'table' }])

    const result = await renameView(7, 'user-test', '  Pretty Name  ')

    const setCall = vi.mocked(db.update).mock.results[0].value.set
    const patch = setCall.mock.calls[0][0]
    expect(patch.name).toBe('Pretty Name')
    expect(result).toEqual({ view: expect.objectContaining({ id: 7, name: 'Pretty Name' }) })
  })
})

describe('seedAutoViews', () => {
  // We assert via the resulting db.insert calls: each successful createView
  // call inserts one row into the `views` table. Counting inserts and
  // inspecting their {type, config} reveals what was seeded.
  function insertedViews(): Array<{ name: string; type: string; config: Record<string, unknown> }> {
    return vi.mocked(db.insert).mock.results.map((r) => r.value.values.mock.calls[0][0])
  }

  it('seeds nothing when the schema has no fields', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })

    await seedAutoViews('bookmarks', 'user-test', { fields: [], version: 1, lastInferredAt: '' })

    expect(db.insert).not.toHaveBeenCalled()
  })

  it('skips calendar seeding when the only date fields are created_at/updated_at timestamps', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'created_at', type: 'date', inferred: true, position: 0, hidden: false },
        { name: 'updated_at', type: 'date', inferred: true, position: 1, hidden: false },
        { name: 'title', type: 'text', inferred: true, position: 2, hidden: false },
      ],
      version: 1,
      lastInferredAt: '',
    })

    expect(db.insert).not.toHaveBeenCalled()
  })

  it('seeds a Calendar view when a non-timestamp date field is present', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Calendar', slug: 'calendar-aaaaaaaa', type: 'calendar' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'due_date', type: 'date', inferred: true, position: 0, hidden: false },
        { name: 'title', type: 'text', inferred: true, position: 1, hidden: false },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    const calendar = inserted.find((v) => v.type === 'calendar')!
    expect(calendar.name).toBe('Calendar')
    expect(calendar.config).toEqual(expect.objectContaining({ dateField: 'due_date' }))
  })

  it('seeds a Kanban view when a select field is present', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Kanban', slug: 'kanban-aaaaaaaa', type: 'kanban' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'title', type: 'text', inferred: true, position: 0, hidden: false },
        { name: 'status', type: 'select', inferred: true, position: 1, hidden: false, options: ['open', 'closed'] },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    expect(inserted).toHaveLength(1)
    expect(inserted[0].name).toBe('Kanban')
    expect(inserted[0].type).toBe('kanban')
    expect(inserted[0].config).toEqual(expect.objectContaining({ groupByField: 'status' }))
  })

  it('seeds Calendar, Kanban, and Timeline when date and select fields exist', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Seeded', slug: 'seeded-aaaaaaaa', type: 'kanban' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'due_date', type: 'date', inferred: true, position: 0, hidden: false },
        { name: 'priority', type: 'select', inferred: true, position: 1, hidden: false, options: ['low', 'high'] },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    expect(inserted).toHaveLength(3)
    const types = inserted.map((v) => v.type).sort()
    expect(types).toEqual(['calendar', 'kanban', 'timeline'])
    const calendarConfig = inserted.find((v) => v.type === 'calendar')!.config
    const kanbanConfig = inserted.find((v) => v.type === 'kanban')!.config
    const timelineConfig = inserted.find((v) => v.type === 'timeline')!.config
    expect(calendarConfig).toEqual(expect.objectContaining({ dateField: 'due_date' }))
    expect(kanbanConfig).toEqual(expect.objectContaining({ groupByField: 'priority' }))
    expect(timelineConfig).toEqual(expect.objectContaining({ dateField: 'due_date' }))
  })

  it('seeds a Timeline view alongside Calendar when a non-timestamp date field exists', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Timeline', slug: 'timeline-aaaaaaaa', type: 'timeline' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'due_date', type: 'date', inferred: true, position: 0, hidden: false },
        { name: 'title', type: 'text', inferred: true, position: 1, hidden: false },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    const types = inserted.map((v) => v.type).sort()
    expect(types).toEqual(['calendar', 'timeline'])
    const timelineConfig = inserted.find((v) => v.type === 'timeline')!.config
    expect(timelineConfig).toEqual(expect.objectContaining({ dateField: 'due_date' }))
  })

  it('uses the first matching date field when multiple non-timestamp date fields exist', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Calendar', slug: 'calendar-aaaaaaaa', type: 'calendar' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'start_date', type: 'date', inferred: true, position: 0, hidden: false },
        { name: 'end_date', type: 'date', inferred: true, position: 1, hidden: false },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    const calendar = inserted.find((v) => v.type === 'calendar')!
    expect(calendar.config).toEqual(expect.objectContaining({ dateField: 'start_date' }))
  })

  it('seeds a Gallery view when an image_url field is present', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Gallery', slug: 'gallery-aaaaaaaa', type: 'gallery' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'filename', type: 'text', inferred: true, position: 0, hidden: false },
        { name: 'screenshot', type: 'image_url', inferred: true, position: 1, hidden: false },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    expect(inserted).toHaveLength(1)
    expect(inserted[0].type).toBe('gallery')
    expect(inserted[0].config).toEqual(expect.objectContaining({
      imageField: 'screenshot',
      cardTitle: 'filename',
    }))
  })

  it('seeds a Gallery view without cardTitle when no text field exists', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Gallery', slug: 'gallery-aaaaaaaa', type: 'gallery' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'screenshot', type: 'image_url', inferred: true, position: 0, hidden: false },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    expect(inserted).toHaveLength(1)
    expect(inserted[0].config).toEqual({ imageField: 'screenshot' })
  })

  it('seeds all three view types when fields supporting each exist', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Seeded', slug: 'seeded-aaaaaaaa', type: 'gallery' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'filename', type: 'text', inferred: true, position: 0, hidden: false },
        { name: 'due_date', type: 'date', inferred: true, position: 1, hidden: false },
        { name: 'priority', type: 'select', inferred: true, position: 2, hidden: false, options: ['low', 'high'] },
        { name: 'screenshot', type: 'image_url', inferred: true, position: 3, hidden: false },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    expect(inserted).toHaveLength(4)
    const types = inserted.map((v) => v.type).sort()
    expect(types).toEqual(['calendar', 'gallery', 'kanban', 'timeline'])
  })

  it('counts a multiselect field as a kanban candidate', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Kanban', slug: 'kanban-aaaaaaaa', type: 'kanban' }])

    await seedAutoViews('bookmarks', 'user-test', {
      fields: [
        { name: 'tags', type: 'multiselect', inferred: true, position: 0, hidden: false, options: ['a', 'b'] },
      ],
      version: 1,
      lastInferredAt: '',
    })

    const inserted = insertedViews()
    expect(inserted).toHaveLength(1)
    expect(inserted[0].type).toBe('kanban')
    expect(inserted[0].config).toEqual(expect.objectContaining({ groupByField: 'tags' }))
  })

  it('swallows createView failures and resolves cleanly', async () => {
    // Make findAccessibleCollectionBySlug throw inside createView so each
    // createView call rejects. seedAutoViews should not propagate.
    vi.mocked(findAccessibleCollectionBySlug).mockRejectedValue(new Error('boom'))

    await expect(
      seedAutoViews('bookmarks', 'user-test', {
        fields: [
          { name: 'due_date', type: 'date', inferred: true, position: 0, hidden: false },
          { name: 'status', type: 'select', inferred: true, position: 1, hidden: false, options: ['a', 'b'] },
        ],
        version: 1,
        lastInferredAt: '',
      })
    ).resolves.toBeUndefined()
  })
})
