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
        where: vi.fn(() => ({ limit: selectLimit })),
      })),
    })),
  },
}))

vi.mock('@/lib/db/queries', () => ({
  findAccessibleCollectionBySlug: vi.fn(),
}))

// Name resolution has its own tests (resolve.test.ts and the integration
// suite); here a slug argument resolves exactly as the mocked slug lookup says.
vi.mock('./resolve', async () => {
  const queries = await import('@/lib/db/queries')
  return {
    findAccessibleCollection: (ref: string, userId: string, role?: string) =>
      (queries.findAccessibleCollectionBySlug as (...a: unknown[]) => unknown)(ref, userId, role),
  }
})

vi.mock('@/lib/revalidation', () => ({
  revalidateDashboard: vi.fn(),
}))

import { createView, renameView, updateView, updateViewConfig, seedAutoViews } from './views'
import { findAccessibleCollectionBySlug } from '@/lib/db/queries'
import { db } from '@/lib/db'
import { revalidateDashboard } from '@/lib/revalidation'

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
  storage: {},
  migrationState: null,
  migrationSwappedAt: null,
  migrationReport: null,
  migrationError: null,
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

  it('merges groupBy into the allowlisted caller config, dropping unknown keys', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    insertReturning.mockResolvedValue([{ id: 1, name: 'Kanban', slug: 'kanban-aaaaaaaa', type: 'kanban' }])

    await createView('bookmarks', 'user-test', {
      type: 'kanban',
      groupBy: 'status',
      config: { cardTitle: 'title', color: 'blue' },
    } as never)

    const valuesCall = vi.mocked(db.insert).mock.results[0].value.values
    const inserted = valuesCall.mock.calls[0][0]
    expect(inserted.config).toEqual({ groupByField: 'status', cardTitle: 'title' })
  })
})

describe('publishing a view', () => {
  // A published view shows only its columns, so they must be visible fields
  // of the saved schema; the field its layout needs is added for it.
  const schema = {
    fields: [
      { name: 'title', type: 'text', inferred: true, position: 0, hidden: false },
      { name: 'status', type: 'select', inferred: true, position: 1, hidden: false },
      { name: 'priority', type: 'select', inferred: true, position: 2, hidden: false },
      { name: 'due', type: 'date', inferred: true, position: 3, hidden: false },
      { name: 'cover', type: 'image_url', inferred: true, position: 4, hidden: false },
      { name: 'secret', type: 'text', inferred: true, position: 5, hidden: true },
    ],
    version: 1,
    lastInferredAt: '',
  }
  const VALID = 'Valid fields: title, status, priority, due, cover.'
  const withSchema = (s: unknown = schema) => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: { ...collectionRow, schema: s }, role: 'editor' } as never)
    insertReturning.mockResolvedValue([{ id: 1 }])
    updateReturning.mockResolvedValue([{ id: 7 }])
  }
  const inserted = () => vi.mocked(db.insert).mock.results[0].value.values.mock.calls[0][0]
  const updateSet = () => vi.mocked(db.update).mock.results[0].value.set.mock.calls[0][0]

  describe('createView', () => {
    it('refuses to publish without columns, listing the valid fields, and inserts nothing', async () => {
      withSchema()
      const result = await createView('bookmarks', 'user-test', { type: 'table', published: true })
      expect(result).toEqual({
        error: `Set columns before publishing: a published view shows only the fields listed in its columns. ${VALID}`,
        status: 400,
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('refuses hidden and unknown columns, naming them', async () => {
      withSchema()
      const result = await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['title', 'secret', 'nope'] })
      expect(result).toEqual({
        error: `These columns are hidden or not in the collection's saved schema, so they cannot be published: secret, nope. ${VALID}`,
        status: 400,
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('says when the collection has no saved schema fields yet', async () => {
      withSchema(null)
      const result = await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['title'] })
      expect(result).toEqual(expect.objectContaining({ status: 400, error: expect.stringMatching(/^This collection has no saved schema fields yet .*hutch_infer_schema/) }))
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('publishes visible columns as given', async () => {
      withSchema()
      const result = await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['due', 'title'] })
      expect(result).not.toHaveProperty('error')
      expect(inserted()).toEqual(expect.objectContaining({ published: true, columns: ['due', 'title'] }))
    })

    it('does not check the columns of an unpublished view', async () => {
      withSchema(null)
      await createView('bookmarks', 'user-test', { type: 'table', columns: ['anything'] })
      expect(inserted()).toEqual(expect.objectContaining({ published: false, columns: ['anything'] }))
    })

    it.each([
      ['kanban', { groupBy: 'status' }, 'status'],
      ['kanban', { config: { groupByField: 'status' } }, 'status'],
      ['kanban', { config: { groupField: 'priority' } }, 'priority'],
      ['calendar', { config: { dateField: 'due' } }, 'due'],
      ['timeline', { config: { dateField: 'due' } }, 'due'],
      ['gallery', { config: { imageField: 'cover' } }, 'cover'],
    ])('appends the layout field of a published %s view (%j)', async (type, extra, field) => {
      withSchema()
      await createView('bookmarks', 'user-test', { type, published: true, columns: ['title'], ...extra })
      expect(inserted().columns).toEqual(['title', field])
    })

    it('prefers the dashboard groupField over groupByField, as readers do', async () => {
      withSchema()
      await createView('bookmarks', 'user-test', { type: 'kanban', published: true, columns: ['title'], config: { groupField: 'priority', groupByField: 'status' } })
      expect(inserted().columns).toEqual(['title', 'priority'])
    })

    it('does not append a layout field that is hidden, unknown or already a column', async () => {
      withSchema()
      await createView('bookmarks', 'user-test', { type: 'gallery', published: true, columns: ['title'], config: { imageField: 'secret' } })
      expect(inserted().columns).toEqual(['title'])
      vi.mocked(db.insert).mockClear()
      await createView('bookmarks', 'user-test', { type: 'calendar', published: true, columns: ['title'], config: { dateField: 'nope' } })
      expect(inserted().columns).toEqual(['title'])
      vi.mocked(db.insert).mockClear()
      await createView('bookmarks', 'user-test', { type: 'kanban', published: true, columns: ['status', 'title'], groupBy: 'status' })
      expect(inserted().columns).toEqual(['status', 'title'])
    })

    it('does not append the layout field to an unpublished view', async () => {
      withSchema()
      await createView('bookmarks', 'user-test', { type: 'kanban', columns: ['title'], groupBy: 'status' })
      expect(inserted().columns).toEqual(['title'])
    })
  })

  describe('updateView', () => {
    const stored = (view: Record<string, unknown>) =>
      selectLimit.mockResolvedValue([{ id: 7, type: 'table', columns: [], config: {}, published: false, ...view }])

    it('refuses to publish a view whose stored columns are empty', async () => {
      withSchema()
      stored({ columns: [] })
      const result = await updateView('bookmarks', 7, 'user-test', { published: true })
      expect(result).toEqual(expect.objectContaining({ status: 400, error: expect.stringMatching(/^Set columns before publishing/) }))
      expect(db.update).not.toHaveBeenCalled()
    })

    it('refuses to publish a view whose stored columns include a hidden field', async () => {
      withSchema()
      stored({ columns: ['title', 'secret'] })
      const result = await updateView('bookmarks', 7, 'user-test', { published: true })
      expect(result).toEqual(expect.objectContaining({ status: 400, error: expect.stringContaining('cannot be published: secret.') }))
      expect(db.update).not.toHaveBeenCalled()
    })

    it('refuses to clear the columns of a published view', async () => {
      withSchema()
      stored({ columns: ['title'], published: true })
      const result = await updateView('bookmarks', 7, 'user-test', { columns: [] })
      expect(result).toEqual(expect.objectContaining({ status: 400, error: expect.stringMatching(/^Set columns before publishing/) }))
      expect(db.update).not.toHaveBeenCalled()
    })

    it('refuses to add an unknown column to a published view', async () => {
      withSchema()
      stored({ columns: ['title'], published: true })
      const result = await updateView('bookmarks', 7, 'user-test', { columns: ['title', 'nope'] })
      expect(result).toEqual(expect.objectContaining({ status: 400, error: expect.stringContaining('cannot be published: nope.') }))
      expect(db.update).not.toHaveBeenCalled()
    })

    it('publishes with new columns and appends the layout field', async () => {
      withSchema()
      stored({ type: 'kanban', config: { groupByField: 'status' } })
      const result = await updateView('bookmarks', 7, 'user-test', { published: true, columns: ['title'] })
      expect(result).not.toHaveProperty('error')
      expect(updateSet()).toEqual(expect.objectContaining({ published: true, columns: ['title', 'status'] }))
    })

    it('lets a view be unpublished and its columns cleared in one call', async () => {
      withSchema()
      stored({ columns: ['title'], published: true })
      const result = await updateView('bookmarks', 7, 'user-test', { published: false, columns: [] })
      expect(result).not.toHaveProperty('error')
      expect(updateSet()).toEqual(expect.objectContaining({ published: false, columns: [] }))
    })

    it('does not check the columns of an unpublished view', async () => {
      withSchema(null)
      stored({ columns: ['title'] })
      await updateView('bookmarks', 7, 'user-test', { columns: ['anything'] })
      expect(updateSet().columns).toEqual(['anything'])
    })

    it('appends the new group field when a published kanban is regrouped', async () => {
      withSchema()
      stored({ type: 'kanban', columns: ['title', 'status'], config: { groupByField: 'status' }, published: true })
      await updateView('bookmarks', 7, 'user-test', { groupBy: 'priority' })
      expect(updateSet()).toEqual(expect.objectContaining({ columns: ['title', 'status', 'priority'], config: { groupByField: 'priority' } }))
    })
  })

  describe('updateViewConfig', () => {
    it('appends the new layout field of a published view', async () => {
      withSchema()
      selectLimit.mockResolvedValue([{ id: 7, type: 'kanban', columns: ['title', 'status'], config: { groupByField: 'status' }, published: true }])
      await updateViewConfig('bookmarks', 7, 'user-test', { groupField: 'priority' })
      expect(updateSet()).toEqual(expect.objectContaining({ columns: ['title', 'status', 'priority'] }))
    })

    it('leaves the columns of an unpublished view alone', async () => {
      withSchema()
      selectLimit.mockResolvedValue([{ id: 7, type: 'calendar', columns: ['title'], config: {}, published: false }])
      await updateViewConfig('bookmarks', 7, 'user-test', { dateField: 'due' })
      expect(updateSet()).not.toHaveProperty('columns')
    })
  })
})

describe('renameView', () => {
  it('rejects empty names with status 400', async () => {
    const result = await renameView('bookmarks', 1, 'user-test', '   ')
    expect(result).toEqual(expect.objectContaining({ error: expect.any(String), status: 400 }))
    expect(findAccessibleCollectionBySlug).not.toHaveBeenCalled()
    expect(db.select).not.toHaveBeenCalled()
  })

  it('rejects names longer than 100 characters with status 400', async () => {
    const result = await renameView('bookmarks', 1, 'user-test', 'x'.repeat(101))
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
    expect(db.select).not.toHaveBeenCalled()
  })

  it('returns 404 without looking up the view when the caller lacks editor access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await renameView('bookmarks', 7, 'user-test', 'New Name')
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
    expect(findAccessibleCollectionBySlug).toHaveBeenCalledWith('bookmarks', 'user-test', 'editor')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('returns 404 when the view is not in the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    selectLimit.mockResolvedValue([])
    const result = await renameView('bookmarks', 99, 'user-test', 'New Name')
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
    expect(db.update).not.toHaveBeenCalled()
  })

  it('trims whitespace, updates the name, and revalidates the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    selectLimit.mockResolvedValue([{ config: {} }])
    updateReturning.mockResolvedValue([{ id: 7, name: 'Pretty Name', slug: 'table-aaaaaaaa', type: 'table' }])

    const result = await renameView('bookmarks', 7, 'user-test', '  Pretty Name  ')

    const setCall = vi.mocked(db.update).mock.results[0].value.set
    const patch = setCall.mock.calls[0][0]
    expect(patch.name).toBe('Pretty Name')
    expect(result).toEqual({ view: expect.objectContaining({ id: 7, name: 'Pretty Name' }) })
    expect(revalidateDashboard).toHaveBeenCalledWith('bookmarks', 'views')
  })
})

describe('updateViewConfig', () => {
  it('returns null without looking up the view when the caller lacks editor access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await updateViewConfig('bookmarks', 7, 'user-test', { cardTitle: 'title' })
    expect(result).toBeNull()
    expect(findAccessibleCollectionBySlug).toHaveBeenCalledWith('bookmarks', 'user-test', 'editor')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('returns null when the view is not in the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    selectLimit.mockResolvedValue([])
    const result = await updateViewConfig('bookmarks', 99, 'user-test', { cardTitle: 'title' })
    expect(result).toBeNull()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('merges allowed keys into the existing config and revalidates the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: collectionRow, role: 'editor' })
    selectLimit.mockResolvedValue([{ config: { dateField: 'due' } }])
    updateReturning.mockResolvedValue([{ id: 7 }])

    const result = await updateViewConfig('bookmarks', 7, 'user-test', { cardTitle: 'title', evil: 'x' })

    const setCall = vi.mocked(db.update).mock.results[0].value.set
    expect(setCall.mock.calls[0][0].config).toEqual({ dateField: 'due', cardTitle: 'title' })
    expect(result).toEqual({ view: { id: 7 } })
    expect(revalidateDashboard).toHaveBeenCalledWith('bookmarks', 'views')
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
