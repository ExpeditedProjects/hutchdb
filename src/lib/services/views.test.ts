import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertReturning = vi.fn()
const updateReturning = vi.fn()
const selectLimit = vi.fn()

vi.mock('@/lib/db', () => {
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: insertReturning })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
      })),
    })),
    // View changes read the row with .limit(1).for("update").
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => ({ for: selectLimit })) })),
      })),
    })),
    // The transaction runs on the same mocks.
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(db)),
  }
  return { db }
})

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

import { createView, renameView, updateView, updateViewConfig, seedAutoViews, MAX_PUBLISHED_COLUMNS } from './views'
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
  // A published view shows only its columns, so they must be distinct visible
  // fields of the saved schema and include the field the layout uses; only
  // the collection's owner may publish or change a published view.
  const schema = {
    fields: [
      { name: 'title', type: 'text', inferred: true, position: 0, hidden: false },
      { name: 'status', type: 'select', inferred: true, position: 1, hidden: false },
      { name: 'priority', type: 'select', inferred: true, position: 2, hidden: false },
      { name: 'due', type: 'date', inferred: true, position: 3, hidden: false },
      { name: 'cover', type: 'image_url', inferred: true, position: 4, hidden: false },
      { name: 'secret', type: 'select', inferred: true, position: 5, hidden: true },
    ],
    version: 1,
    lastInferredAt: '',
  }
  const VALID = 'Valid fields: title, status, priority, due, cover.'
  const OWNER_ONLY = { error: "Only the collection's owner can publish a view or change a published one.", status: 403, code: 'owner_only' }
  const as = (role: 'owner' | 'editor', s: unknown = schema) => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: { ...collectionRow, schema: s }, role } as never)
    insertReturning.mockResolvedValue([{ id: 1 }])
    updateReturning.mockResolvedValue([{ id: 7 }])
  }
  const inserted = () => vi.mocked(db.insert).mock.results[0].value.values.mock.calls[0][0]
  const updateSet = () => vi.mocked(db.update).mock.results[0].value.set.mock.calls[0][0]
  const stored = (view: Record<string, unknown>) =>
    selectLimit.mockResolvedValue([{ id: 7, type: 'table', columns: [], config: {}, published: false, ...view }])

  describe('createView', () => {
    it('refuses to publish for an editor, and inserts nothing', async () => {
      as('editor')
      expect(await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['title'] })).toEqual(OWNER_ONLY)
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('refuses to publish without columns, listing the valid fields', async () => {
      as('owner')
      expect(await createView('bookmarks', 'user-test', { type: 'table', published: true })).toEqual({
        error: `Set columns before publishing: a published view shows only the fields listed in its columns. ${VALID}`,
        status: 400,
        code: 'invalid_columns',
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('refuses hidden, unknown and non-string columns, naming them', async () => {
      as('owner')
      const result = await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['title', 'secret', 'nope', 5, { a: 1 }] as never })
      expect(result).toEqual({
        error: `These columns are hidden or not in the collection's saved schema, so they cannot be published: secret, nope, 5, {"a":1}. ${VALID}`,
        status: 400,
        code: 'invalid_columns',
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('echoes at most 50 invalid names, each cut to 100 characters', async () => {
      as('owner')
      const long = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(200)}`)
      const { error } = await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: long }) as { error: string }
      expect(error).toContain(`${'00'}${'x'.repeat(98)}…, `)
      expect(error).not.toContain('x'.repeat(99))
      expect(error).toContain(`49${'x'.repeat(98)}…, and 10 more. ${VALID}`)
      expect(error).not.toContain('50x')
    })

    it('refuses duplicate columns', async () => {
      as('owner')
      expect(await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['title', 'due', 'title'] })).toEqual({
        error: 'These columns are listed more than once: title. List each field once.',
        status: 400,
      })
    })

    it(`refuses more than ${MAX_PUBLISHED_COLUMNS} columns`, async () => {
      as('owner')
      const columns = Array.from({ length: MAX_PUBLISHED_COLUMNS + 1 }, () => 'title')
      expect(await createView('bookmarks', 'user-test', { type: 'table', published: true, columns })).toEqual({
        error: `A published view can have at most ${MAX_PUBLISHED_COLUMNS} columns; this one has ${MAX_PUBLISHED_COLUMNS + 1}.`,
        status: 400,
      })
    })

    it('says when the collection has no visible saved schema fields, without naming MCP tools', async () => {
      for (const s of [null, { fields: [] }, { fields: [{ name: 'secret', type: 'text', hidden: true }] }]) {
        as('owner', s)
        expect(await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['title'] })).toEqual({
          error: 'This collection has no saved schema fields yet (or all of them are hidden), so its views cannot be published. Save its schema or unhide a field, then pick the columns.',
          status: 400,
          code: 'no_publishable_fields',
        })
      }
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('publishes distinct visible columns as given', async () => {
      as('owner')
      const result = await createView('bookmarks', 'user-test', { type: 'table', published: true, columns: ['due', 'title'] })
      expect(result).not.toHaveProperty('error')
      expect(inserted()).toEqual(expect.objectContaining({ published: true, columns: ['due', 'title'] }))
    })

    it('does not check the columns of an unpublished view, for an editor either', async () => {
      as('editor', null)
      await createView('bookmarks', 'user-test', { type: 'kanban', columns: ['anything'], groupBy: 'nope' })
      expect(inserted()).toEqual(expect.objectContaining({ published: false, columns: ['anything'] }))
    })

    it.each([
      ['kanban', { groupBy: 'status' }, 'groups by "status"', 'status'],
      ['kanban', { config: { groupByField: 'status' } }, 'groups by "status"', 'status'],
      ['kanban', { config: { groupField: 'priority' } }, 'groups by "priority"', 'priority'],
      ['kanban', { config: { groupField: 'priority', groupByField: 'status' } }, 'groups by "priority"', 'priority'],
      ['calendar', { config: { dateField: 'due' } }, 'places records by the date in "due"', 'due'],
      ['timeline', { config: { dateField: 'due' } }, 'places records by the date in "due"', 'due'],
      ['gallery', { config: { imageField: 'cover' } }, 'shows the images in "cover"', 'cover'],
    ])('requires a published %s view (%j) to list its layout field', async (type, extra, uses, field) => {
      as('owner')
      expect(await createView('bookmarks', 'user-test', { type, published: true, columns: ['title'], ...extra })).toEqual({
        error: `This ${type} view ${uses}, so "${field}" must be one of its columns before it can be published.`,
        status: 400,
      })
      expect(db.insert).not.toHaveBeenCalled()
      await createView('bookmarks', 'user-test', { type, published: true, columns: ['title', field], ...extra })
      expect(inserted().columns).toEqual(['title', field])
    })

    it.each(['secret', 'nope'])('refuses a layout field that is hidden or unknown (%s)', async (field) => {
      as('owner')
      expect(await createView('bookmarks', 'user-test', { type: 'gallery', published: true, columns: ['title'], config: { imageField: field } })).toEqual({
        error: `This gallery view shows the images in "${field}", which is hidden or not in the collection's saved schema, so the view cannot be published.`,
        status: 400,
        code: 'invalid_columns',
      })
    })

    it('does not crash on a view type that names an Object.prototype key', async () => {
      as('owner')
      for (const type of ['constructor', '__proto__', 'toString']) {
        vi.mocked(db.insert).mockClear()
        const result = await createView('bookmarks', 'user-test', { type, published: true, columns: ['title'], config: { dateField: 'nope' } })
        expect(result).not.toHaveProperty('error')
        expect(inserted().columns).toEqual(['title'])
      }
    })

    it('drops a stale dashboard groupField when group_by is given', async () => {
      as('owner')
      await createView('bookmarks', 'user-test', { type: 'kanban', groupBy: 'status', config: { groupField: 'priority' } })
      expect(inserted().config).toEqual({ groupByField: 'status' })
    })

    it('infers a kanban grouping from the first visible select field when asked', async () => {
      as('owner', { fields: [{ name: 'secret', type: 'select', hidden: true }, { name: 'title', type: 'text' }, { name: 'status', type: 'select', hidden: false }] })
      await createView('bookmarks', 'user-test', { type: 'kanban', inferGroupBy: true })
      expect(inserted().config).toEqual({ groupByField: 'status' })
    })

    it('does not infer a grouping unless asked, or when config already names one', async () => {
      as('owner')
      await createView('bookmarks', 'user-test', { type: 'kanban' })
      expect(inserted().config).toEqual({})
      vi.mocked(db.insert).mockClear()
      await createView('bookmarks', 'user-test', { type: 'kanban', inferGroupBy: true, config: { groupField: 'priority' } })
      expect(inserted().config).toEqual({ groupField: 'priority' })
    })

    it('fails when asked to infer a grouping and no visible select field exists', async () => {
      as('owner', { fields: [{ name: 'secret', type: 'select', hidden: true }, { name: 'title', type: 'text' }] })
      expect(await createView('bookmarks', 'user-test', { type: 'kanban', inferGroupBy: true })).toEqual({
        error: 'Cannot infer a field to group by: the collection has no visible select field.',
        status: 400,
        code: 'no_group_field',
      })
      expect(db.insert).not.toHaveBeenCalled()
    })
  })

  describe('updateView', () => {
    it('locks the view row while it reads and writes', async () => {
      as('owner')
      stored({ columns: ['title'] })
      await updateView('bookmarks', 7, 'user-test', { published: true })
      expect(db.transaction).toHaveBeenCalledTimes(1)
      expect(selectLimit).toHaveBeenCalledWith('update')
    })

    it.each([
      ['publish', {}, { published: true, columns: ['title'] }],
      ['rename a published view', { published: true }, { name: 'New' }],
      ['refilter a published view', { published: true }, { filter: { status: 'open' } }],
      ['resort a published view', { published: true }, { sort: '-due' }],
      ['change the columns of a published view', { published: true }, { columns: ['title', 'due'] }],
      ['change the config of a published view', { published: true }, { config: { cardTitle: 'title' } }],
      ['regroup a published view', { published: true, type: 'kanban' }, { groupBy: 'status' }],
      ['re-publish a published view', { published: true }, { published: true }],
    ])('refuses an editor to %s, writing nothing', async (_, view, patch) => {
      as('editor')
      stored({ columns: ['title'], ...view })
      expect(await updateView('bookmarks', 7, 'user-test', patch)).toEqual(OWNER_ONLY)
      expect(db.update).not.toHaveBeenCalled()
    })

    it.each([
      ['unpublish a published view', { published: true }, { published: false }],
      ['unpublish and change a view in one call', { published: true, type: 'kanban' }, { published: false, groupBy: 'priority', columns: [] }],
      ['change an unpublished view', {}, { name: 'New', columns: ['anything'] }],
    ])('lets an editor %s', async (_, view, patch) => {
      as('editor')
      stored({ columns: ['title'], ...view })
      const result = await updateView('bookmarks', 7, 'user-test', patch)
      expect(result).not.toHaveProperty('error')
      expect(db.update).toHaveBeenCalled()
    })

    it('refuses to publish a view whose stored columns are empty or not strings', async () => {
      as('owner')
      for (const columns of [[], ['title', 3], null]) {
        stored({ columns })
        expect(await updateView('bookmarks', 7, 'user-test', { published: true })).toEqual(expect.objectContaining({ status: 400, code: 'invalid_columns' }))
      }
      expect(db.update).not.toHaveBeenCalled()
    })

    it('writes the checked columns whenever the check runs', async () => {
      as('owner')
      stored({ columns: ['title', 'due'] })
      await updateView('bookmarks', 7, 'user-test', { published: true })
      expect(updateSet()).toEqual(expect.objectContaining({ published: true, columns: ['title', 'due'] }))
    })

    it('refuses to clear or break the columns of a published view', async () => {
      as('owner')
      stored({ columns: ['title'], published: true })
      expect(await updateView('bookmarks', 7, 'user-test', { columns: [] })).toEqual(expect.objectContaining({ status: 400, error: expect.stringMatching(/^Set columns before publishing/) }))
      expect(await updateView('bookmarks', 7, 'user-test', { columns: ['title', 'nope'] })).toEqual(expect.objectContaining({ status: 400, error: expect.stringContaining('cannot be published: nope.') }))
      expect(db.update).not.toHaveBeenCalled()
    })

    it('checks a published view whose config changes, even with the same columns', async () => {
      as('owner')
      stored({ columns: ['title', 'secret'], published: true })
      expect(await updateView('bookmarks', 7, 'user-test', { config: { cardTitle: 'title' } })).toEqual(expect.objectContaining({ status: 400, code: 'invalid_columns' }))
      expect(db.update).not.toHaveBeenCalled()
    })

    it('lets a published kanban regroup only to a field among its columns', async () => {
      as('owner')
      stored({ type: 'kanban', columns: ['title', 'status', 'priority'], config: { groupByField: 'status' }, published: true })
      expect(await updateView('bookmarks', 7, 'user-test', { groupBy: 'due' })).toEqual({
        error: 'This kanban view groups by "due", so "due" must be one of its columns before it can be published.',
        status: 400,
      })
      expect(db.update).not.toHaveBeenCalled()
      await updateView('bookmarks', 7, 'user-test', { groupBy: 'priority' })
      expect(updateSet()).toEqual(expect.objectContaining({ config: { groupByField: 'priority' }, columns: ['title', 'status', 'priority'] }))
    })

    it('lets a view be unpublished and regrouped in one call without a check', async () => {
      as('owner')
      stored({ type: 'kanban', columns: ['title'], config: { groupByField: 'status' }, published: true })
      const result = await updateView('bookmarks', 7, 'user-test', { published: false, groupBy: 'nope' })
      expect(result).not.toHaveProperty('error')
      expect(updateSet()).toEqual({ published: false, publishedBy: null, publishedAt: null, config: { groupByField: 'nope' }, updatedAt: expect.any(Date) })
    })

    it('does not check an unpublished view that stays unpublished', async () => {
      as('owner', null)
      stored({ columns: ['title'] })
      await updateView('bookmarks', 7, 'user-test', { columns: ['anything'] })
      expect(updateSet()).toEqual({ columns: ['anything'], updatedAt: expect.any(Date) })
    })
  })

  describe('updateViewConfig and renameView', () => {
    it('refuse an editor on a published view, writing nothing', async () => {
      as('editor')
      stored({ type: 'kanban', columns: ['title', 'status'], config: { groupByField: 'status' }, published: true })
      expect(await updateViewConfig('bookmarks', 7, 'user-test', { cardTitle: 'title' })).toEqual(OWNER_ONLY)
      expect(await renameView('bookmarks', 7, 'user-test', 'New')).toEqual(OWNER_ONLY)
      expect(db.update).not.toHaveBeenCalled()
    })

    it('let an editor change an unpublished view', async () => {
      as('editor')
      stored({ type: 'calendar', columns: ['title'] })
      expect(await updateViewConfig('bookmarks', 7, 'user-test', { dateField: 'due' })).toEqual({ view: { id: 7 } })
      expect(updateSet()).toEqual({ config: { dateField: 'due' }, updatedAt: expect.any(Date) })
      expect(await renameView('bookmarks', 7, 'user-test', 'New')).toEqual({ view: { id: 7 } })
    })

    it('updateViewConfig requires a published view\'s new layout field to be one of its columns', async () => {
      as('owner')
      stored({ type: 'kanban', columns: ['title', 'status'], config: { groupByField: 'status' }, published: true })
      expect(await updateViewConfig('bookmarks', 7, 'user-test', { groupField: 'priority' })).toEqual({
        error: 'This kanban view groups by "priority", so "priority" must be one of its columns before it can be published.',
        status: 400,
      })
      expect(db.update).not.toHaveBeenCalled()
      await updateViewConfig('bookmarks', 7, 'user-test', { groupField: 'status' })
      expect(updateSet()).toEqual(expect.objectContaining({ config: { groupByField: 'status', groupField: 'status' }, columns: ['title', 'status'] }))
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
