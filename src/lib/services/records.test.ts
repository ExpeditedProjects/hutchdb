import { describe, it, expect, vi, beforeEach } from 'vitest'

const { insertReturning, insertValues, updateReturning, selectLimit, dbExecute, mockBeforeCreateRecord } = vi.hoisted(() => {
  const insertReturning = vi.fn()
  return {
    insertReturning,
    insertValues: vi.fn(() => ({ returning: insertReturning })),
    updateReturning: vi.fn(),
    selectLimit: vi.fn(),
    dbExecute: vi.fn(),
    mockBeforeCreateRecord: vi.fn(),
  }
})

// Partial mock: replace the beforeCreateRecord hook so tests can make it
// reject, but keep the module's other exports (notably the real
// QuotaExceededError class) so instanceof detection in the service works.
vi.mock('@/lib/quota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quota')>()),
  beforeCreateRecord: mockBeforeCreateRecord,
}))

vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: insertValues,
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: updateReturning })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimit,
          orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ offset: vi.fn().mockResolvedValue([]) })) })),
        })),
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
          })),
        })),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    execute: dbExecute,
  },
}))

vi.mock('@/lib/db/queries', () => ({
  findCollectionByNameInOrg: vi.fn(),
  findCollectionBySlugInOrg: vi.fn(),
  findAccessibleCollectionBySlug: vi.fn(),
  createCollectionWithOwner: vi.fn(),
  getCollectionRecordCount: vi.fn().mockResolvedValue(0),
  queryRecords: vi.fn(),
  notDeleted: { __notDeleted: true },
}))

vi.mock('@/lib/revalidation', () => ({
  revalidateDashboard: vi.fn(),
}))

vi.mock('@/lib/schema-inference', () => ({
  inferSchema: vi.fn().mockResolvedValue({ fields: [], version: 1 }),
  mergeSchema: vi.fn((_, b) => b),
  detectNewFields: vi.fn().mockReturnValue(false),
  inferSchemaFromData: vi.fn().mockReturnValue({
    fields: [
      { name: 'due_date', type: 'date', inferred: true, position: 0, hidden: false },
      { name: 'priority', type: 'select', inferred: true, position: 1, hidden: false, options: ['low', 'high'] },
    ],
    version: 1,
    lastInferredAt: '',
  }),
}))

vi.mock('./views', () => ({
  seedAutoViews: vi.fn().mockResolvedValue(undefined),
}))

import {
  createRecords,
  queryRecords,
  truncateRecords,
  updateRecord,
  transformRecords,
  updateRecordStatus,
  deleteRecord,
  exportRecords,
  importRecords,
} from './records'
import {
  findCollectionByNameInOrg,
  findCollectionBySlugInOrg,
  findAccessibleCollectionBySlug,
  createCollectionWithOwner,
  queryRecords as queryRecordsEngine,
} from '@/lib/db/queries'
import { seedAutoViews } from './views'

const baseCollection = {
  id: 1,
  apiKeyId: 1,
  organizationId: 'org-test',
  name: 'Users',
  slug: 'users',
  uniqueKey: [],
  schema: { fields: [], version: 1, lastInferredAt: new Date().toISOString() },
  description: null,
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

describe('createRecords', () => {
  it('returns 400 when collection name is missing', async () => {
    const result = await createRecords('user-test', 'org-test', { collection: '' })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('returns 400 when neither data nor records is supplied', async () => {
    const result = await createRecords('user-test', 'org-test', { collection: 'users' })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('returns 413 when a single record exceeds the 1MB size limit', async () => {
    const huge = { content: 'x'.repeat(1_100_000) }
    const result = await createRecords('user-test', 'org-test', { collection: 'users', data: huge })
    expect(result).toEqual(expect.objectContaining({ status: 413 }))
  })

  it('auto-creates the collection when none exists', async () => {
    vi.mocked(findCollectionByNameInOrg).mockResolvedValue(undefined as never)
    vi.mocked(findCollectionBySlugInOrg).mockResolvedValue(undefined as never)
    vi.mocked(createCollectionWithOwner).mockResolvedValue({ ...baseCollection, name: 'New', slug: 'new-aaaaaaaa' })
    insertReturning.mockResolvedValue([{ id: 1, data: { hello: 'world' } }])

    const result = await createRecords('user-test', 'org-test', { collection: 'New', data: { hello: 'world' } })

    expect(createCollectionWithOwner).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-test',
      ownerUserId: 'user-test',
      name: 'New',
    }))
    expect(result).toEqual(expect.objectContaining({ action: 'created' }))
  })

  it('uses the fast batch path when no unique_key is set', async () => {
    vi.mocked(findCollectionByNameInOrg).mockResolvedValue(baseCollection)
    insertReturning.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }])

    const result = await createRecords('user-test', 'org-test', {
      collection: 'Users',
      records: [{ a: 1 }, { a: 2 }, { a: 3 }],
    })

    expect(result).toEqual(expect.objectContaining({ count: 3 }))
  })

  describe('auto-seed views on collection auto-create', () => {
    it('calls seedAutoViews once when a collection is auto-created from records', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue(undefined as never)
      vi.mocked(findCollectionBySlugInOrg).mockResolvedValue(undefined as never)
      vi.mocked(createCollectionWithOwner).mockResolvedValue({
        ...baseCollection,
        name: 'Tasks',
        slug: 'tasks-aaaaaaaa',
      })
      insertReturning.mockResolvedValue([{ id: 1, data: { due_date: '2026-05-01', priority: 'high' } }])

      await createRecords('user-test', 'org-test', {
        collection: 'Tasks',
        data: { due_date: '2026-05-01', priority: 'high' },
      })

      expect(seedAutoViews).toHaveBeenCalledTimes(1)
      expect(seedAutoViews).toHaveBeenCalledWith(
        'tasks-aaaaaaaa',
        'user-test',
        expect.objectContaining({
          fields: expect.arrayContaining([
            expect.objectContaining({ name: 'due_date', type: 'date' }),
            expect.objectContaining({ name: 'priority', type: 'select' }),
          ]),
        })
      )
    })

    it('does NOT call seedAutoViews when the collection already exists', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue(baseCollection)
      insertReturning.mockResolvedValue([{ id: 1, data: { due_date: '2026-05-01' } }])

      await createRecords('user-test', 'org-test', {
        collection: 'Users',
        data: { due_date: '2026-05-01' },
      })

      expect(seedAutoViews).not.toHaveBeenCalled()
    })
  })

  describe('summary field (issue #447)', () => {
    it('returns a singular summary for a single created record', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue({ ...baseCollection, name: 'Bookmarks', slug: 'bookmarks' })
      insertReturning.mockResolvedValue([{ id: 1, data: { url: 'x' } }])

      const result = await createRecords('user-test', 'org-test', { collection: 'Bookmarks', data: { url: 'x' } })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Saved 1 record to Bookmarks',
      }))
    })

    it('returns a plural summary for a bulk all-created insert', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue({ ...baseCollection, name: 'Bookmarks', slug: 'bookmarks' })
      insertReturning.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }])

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Bookmarks',
        records: [{ a: 1 }, { a: 2 }, { a: 3 }],
      })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Saved 3 records to Bookmarks',
      }))
    })

    it('uses singular grammar when bulk has exactly one record', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue({ ...baseCollection, name: 'Bookmarks', slug: 'bookmarks' })
      insertReturning.mockResolvedValue([{ id: 1 }])

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Bookmarks',
        records: [{ a: 1 }],
      })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Saved 1 record to Bookmarks',
      }))
    })

    it('prepends "Created <Name>." when the collection is auto-created', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue(undefined as never)
      vi.mocked(findCollectionBySlugInOrg).mockResolvedValue(undefined as never)
      vi.mocked(createCollectionWithOwner).mockResolvedValue({ ...baseCollection, name: 'Bookmarks', slug: 'bookmarks-aaaaaaaa' })
      insertReturning.mockResolvedValue([{ id: 1, data: { url: 'x' } }])

      const result = await createRecords('user-test', 'org-test', { collection: 'Bookmarks', data: { url: 'x' } })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Created Bookmarks. Saved 1 record.',
      }))
    })

    it('prepends "Created <Name>." for an auto-created bulk insert', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue(undefined as never)
      vi.mocked(findCollectionBySlugInOrg).mockResolvedValue(undefined as never)
      vi.mocked(createCollectionWithOwner).mockResolvedValue({ ...baseCollection, name: 'Bookmarks', slug: 'bookmarks-aaaaaaaa' })
      insertReturning.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }])

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Bookmarks',
        records: [{ a: 1 }, { a: 2 }, { a: 3 }],
      })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Created Bookmarks. Saved 3 records.',
      }))
    })

    it('uses "Updated" verb and "in" preposition when on_conflict=merge updates a record', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue({
        ...baseCollection,
        name: 'Bookmarks',
        slug: 'bookmarks',
        uniqueKey: ['url'],
      })
      // existing record found -> update path
      selectLimit.mockResolvedValue([{ id: 7, data: { url: 'x', title: 'old' } }])
      updateReturning.mockResolvedValue([{ id: 7, data: { url: 'x', title: 'new' } }])

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Bookmarks',
        data: { url: 'x', title: 'new' },
        on_conflict: 'merge',
      })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Updated 1 record in Bookmarks',
      }))
    })

    it('uses "Skipped" verb and "in" preposition when on_conflict=skip skips a record', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue({
        ...baseCollection,
        name: 'Bookmarks',
        slug: 'bookmarks',
        uniqueKey: ['url'],
      })
      selectLimit.mockResolvedValue([{ id: 7, data: { url: 'x' } }])

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Bookmarks',
        data: { url: 'x' },
        on_conflict: 'skip',
      })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Skipped 1 record in Bookmarks',
      }))
    })

    it('formats a mixed-action bulk summary with parenthesized breakdown', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue({
        ...baseCollection,
        name: 'Bookmarks',
        slug: 'bookmarks',
        uniqueKey: ['url'],
      })
      // First call: existing match -> updated. Second & third: no match -> created.
      selectLimit
        .mockResolvedValueOnce([{ id: 1, data: { url: 'a', title: 'old' } }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      updateReturning.mockResolvedValue([{ id: 1, data: { url: 'a', title: 'new' } }])
      insertReturning
        .mockResolvedValueOnce([{ id: 2, data: { url: 'b' } }])
        .mockResolvedValueOnce([{ id: 3, data: { url: 'c' } }])

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Bookmarks',
        records: [
          { url: 'a', title: 'new' },
          { url: 'b' },
          { url: 'c' },
        ],
        on_conflict: 'merge',
      })

      expect(result).toEqual(expect.objectContaining({
        summary: 'Saved 3 records to Bookmarks (2 created, 1 updated)',
      }))
    })

    it('omits the summary field on the validation error path', async () => {
      const result = await createRecords('user-test', 'org-test', { collection: '' })
      expect(result).not.toHaveProperty('summary')
    })

    it('omits the summary field on the conflict-error path', async () => {
      vi.mocked(findCollectionByNameInOrg).mockResolvedValue({
        ...baseCollection,
        name: 'Bookmarks',
        slug: 'bookmarks',
        uniqueKey: ['url'],
      })
      selectLimit.mockResolvedValue([{ id: 7, data: { url: 'x' } }])

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Bookmarks',
        data: { url: 'x' },
        on_conflict: 'error',
      })

      expect(result).toEqual(expect.objectContaining({ status: 409 }))
      expect(result).not.toHaveProperty('summary')
    })
  })

  // Failing spec (TDD): the Cloud quota overlay makes beforeCreateRecord throw
  // QuotaExceededError when the org is over its storage cap. createRecords must
  // map that rejection to a { error, status: 413 } result instead of throwing,
  // and must not touch the collection or insert anything afterwards. Any OTHER
  // error from the hook still propagates.
  //
  // QuotaExceededError is referenced via dynamic import so that, until the
  // class exists, only these tests fail — the rest of this file must pass.
  describe('quota seam error mapping (QuotaExceededError → 413)', () => {
    async function makeQuotaError(message: string): Promise<Error> {
      const mod = (await import('@/lib/quota')) as unknown as {
        QuotaExceededError: new (message?: string) => Error
      }
      return new mod.QuotaExceededError(message)
    }

    it('returns { error: <message>, status: 413 } when beforeCreateRecord rejects with QuotaExceededError', async () => {
      mockBeforeCreateRecord.mockRejectedValueOnce(
        await makeQuotaError('Storage quota exceeded for this organization')
      )

      const result = await createRecords('user-test', 'org-test', {
        collection: 'Users',
        data: { a: 1 },
      })

      expect(result).toEqual({
        error: 'Storage quota exceeded for this organization',
        status: 413,
      })
    })

    it('performs no collection lookup/creation and no insert after the quota rejection', async () => {
      mockBeforeCreateRecord.mockRejectedValueOnce(
        await makeQuotaError('Storage quota exceeded for this organization')
      )

      await createRecords('user-test', 'org-test', {
        collection: 'Users',
        records: [{ a: 1 }, { a: 2 }],
      })

      expect(findCollectionByNameInOrg).not.toHaveBeenCalled()
      expect(findCollectionBySlugInOrg).not.toHaveBeenCalled()
      expect(createCollectionWithOwner).not.toHaveBeenCalled()
      const { db } = await import('@/lib/db')
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled()
      expect(insertReturning).not.toHaveBeenCalled()
    })

    it('still propagates non-quota errors from beforeCreateRecord (not swallowed)', async () => {
      mockBeforeCreateRecord.mockRejectedValueOnce(new Error('quota backend unreachable'))

      await expect(
        createRecords('user-test', 'org-test', { collection: 'Users', data: { a: 1 } })
      ).rejects.toThrow('quota backend unreachable')

      expect(findCollectionByNameInOrg).not.toHaveBeenCalled()
      expect(insertReturning).not.toHaveBeenCalled()
    })
  })
})

describe('queryRecords', () => {
  it('returns null when the caller has no access to the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await queryRecords('users', 'user-test', {})
    expect(result).toBeNull()
    expect(queryRecordsEngine).not.toHaveBeenCalled()
  })

  it('forwards the collectionId to the query engine when access is granted', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'viewer' })
    vi.mocked(queryRecordsEngine).mockResolvedValue({ records: [], total: 0, count: 0, limit: 50, offset: 0, has_more: false, next_offset: null })

    await queryRecords('users', 'user-test', { search: 'foo' })

    expect(queryRecordsEngine).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: baseCollection.id,
      search: 'foo',
    }))
  })
})

describe('truncateRecords', () => {
  it('returns null when the caller is not at least an editor', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await truncateRecords('users', 'user-test')
    expect(result).toBeNull()
  })

  it('soft-truncates and returns the slug', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    const result = await truncateRecords('users', 'user-test')
    expect(result).toEqual({ truncated: true, slug: 'users' })
  })
})

describe('updateRecord', () => {
  it('returns null when the caller is not at least an editor', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await updateRecord('users', 'user-test', 5, { name: 'Alice' })
    expect(result).toBeNull()
  })

  it('returns 404 when no row matches the record id', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    updateReturning.mockResolvedValue([])
    const result = await updateRecord('users', 'user-test', 99, { name: 'Alice' })
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })

  it('returns the updated record on success', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    updateReturning.mockResolvedValue([{ id: 5, data: { name: 'Alice' } }])
    const result = await updateRecord('users', 'user-test', 5, { name: 'Alice' })
    expect(result).toEqual(expect.objectContaining({ updated: true }))
  })
})

describe('transformRecords', () => {
  it('rejects field names with invalid characters', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    const result = await transformRecords('users', 'user-test', { remove_fields: ['name; DROP TABLE users--'] })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('rejects rename targets with invalid characters', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    const result = await transformRecords('users', 'user-test', { rename_fields: { good: 'bad name' } })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('rejects set_field with invalid field name', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    const result = await transformRecords('users', 'user-test', { set_field: { field: 'bad-name', value: 1 } })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })
})

describe('updateRecordStatus', () => {
  it('rejects an unknown status with 400', async () => {
    const result = await updateRecordStatus('users', 'user-test', 5, 'definitely-not-a-status')
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('returns null when the caller has no editor access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await updateRecordStatus('users', 'user-test', 5, 'active')
    expect(result).toBeNull()
  })

  it('returns 404 when the record does not exist', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    updateReturning.mockResolvedValue([])
    const result = await updateRecordStatus('users', 'user-test', 99, 'active')
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })
})

describe('deleteRecord', () => {
  it('returns null when the caller has no editor access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await deleteRecord('users', 'user-test', 5)
    expect(result).toBeNull()
  })

  it('returns 404 when no matching active record exists', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    selectLimit.mockResolvedValue([])
    const result = await deleteRecord('users', 'user-test', 99)
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })

  it('soft-deletes and returns the id when the record exists', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    selectLimit.mockResolvedValue([{ id: 5 }])
    const result = await deleteRecord('users', 'user-test', 5)
    expect(result).toEqual({ deleted: true, id: 5 })
  })
})

describe('exportRecords', () => {
  const engineRows = [
    {
      id: 1,
      collectionId: 1,
      status: 'active',
      source: 'api',
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      data: { title: 'First', tags: ['a', 'b'] },
    },
    {
      id: 2,
      collectionId: 1,
      status: 'active',
      source: 'api',
      deletedAt: null,
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: new Date('2026-01-04T00:00:00.000Z'),
      data: { title: 'Second' },
    },
  ]

  function grantAccess() {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg,
      collection: baseCollection,
      role: 'viewer',
    })
  }

  it('returns null when the caller has no access to the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await exportRecords('users', 'user-test', {})
    expect(result).toBeNull()
    expect(queryRecordsEngine).not.toHaveBeenCalled()
  })

  it('defaults to JSON with count/total/truncated metadata', async () => {
    grantAccess()
    vi.mocked(queryRecordsEngine).mockResolvedValue({
      records: engineRows, total: 2, count: 2, limit: 1000, offset: 0, has_more: false, next_offset: null,
    } as never)

    const result = await exportRecords('users', 'user-test', {})

    expect(result).toEqual(expect.objectContaining({
      format: 'json',
      count: 2,
      total: 2,
      truncated: false,
      collection: { name: 'Users', slug: 'users' },
    }))
    const parsed = JSON.parse((result as { content: string }).content)
    expect(parsed).toEqual([
      { id: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', data: { title: 'First', tags: ['a', 'b'] } },
      { id: 2, created_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-04T00:00:00.000Z', data: { title: 'Second' } },
    ])
  })

  it('serializes CSV with system columns first and nested values JSON-stringified', async () => {
    grantAccess()
    vi.mocked(queryRecordsEngine).mockResolvedValue({
      records: engineRows, total: 2, count: 2, limit: 1000, offset: 0, has_more: false, next_offset: null,
    } as never)

    const result = await exportRecords('users', 'user-test', { format: 'csv' })

    const content = (result as { content: string }).content
    expect(content.startsWith('id,created_at,updated_at,title,tags\r\n')).toBe(true)
    expect(content).toContain('1,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z,First,"[""a"",""b""]"')
  })

  it('forwards filter/search/sort/fields to the engine and clamps limit to 10000', async () => {
    grantAccess()
    vi.mocked(queryRecordsEngine).mockResolvedValue({
      records: [], total: 0, count: 0, limit: 10000, offset: 0, has_more: false, next_offset: null,
    } as never)

    await exportRecords('users', 'user-test', {
      filter: { status: { $ne: 'archived' } },
      search: 'foo',
      sort: '-created_at',
      fields: ['title'],
      limit: 99999,
    })

    expect(queryRecordsEngine).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: baseCollection.id,
      filter: { status: { $ne: 'archived' } },
      search: 'foo',
      sort: '-created_at',
      fields: ['title'],
      limit: 10000,
      limitCap: 10000,
    }))
  })

  it('defaults limit to 1000', async () => {
    grantAccess()
    vi.mocked(queryRecordsEngine).mockResolvedValue({
      records: [], total: 0, count: 0, limit: 1000, offset: 0, has_more: false, next_offset: null,
    } as never)

    await exportRecords('users', 'user-test', {})
    expect(queryRecordsEngine).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }))
  })

  it('sets truncated=true when the query has more rows than the limit', async () => {
    grantAccess()
    vi.mocked(queryRecordsEngine).mockResolvedValue({
      records: engineRows, total: 5000, count: 2, limit: 2, offset: 0, has_more: true, next_offset: 2,
    } as never)

    const result = await exportRecords('users', 'user-test', { limit: 2 })
    expect(result).toEqual(expect.objectContaining({ count: 2, total: 5000, truncated: true }))
  })
})

describe('importRecords', () => {
  beforeEach(() => {
    // createRecords path: collection exists, no unique key, batch insert.
    vi.mocked(findCollectionByNameInOrg).mockResolvedValue(baseCollection)
    insertReturning.mockResolvedValue([{ id: 1 }, { id: 2 }])
  })

  it('parses CSV (with type inference) and routes through createRecords', async () => {
    const content = 'name,age,active\r\nAlice,30,true\r\nBob,forty,false\r\n'
    const result = await importRecords('user-test', 'org-test', { collection: 'Users', content })

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ collectionId: 1, data: { name: 'Alice', age: 30, active: true } }),
      expect.objectContaining({ collectionId: 1, data: { name: 'Bob', age: 'forty', active: false } }),
    ])
    expect(result).toEqual(expect.objectContaining({
      collection: { name: 'Users', slug: 'users' },
      count: 2,
      created: 2,
      updated: 0,
      skipped: 0,
      summary: 'Saved 2 records to Users',
    }))
  })

  it('honors the quota hook via the shared createRecords path', async () => {
    const { QuotaExceededError } = await import('@/lib/quota')
    mockBeforeCreateRecord.mockRejectedValueOnce(new QuotaExceededError('quota exceeded'))

    const result = await importRecords('user-test', 'org-test', {
      collection: 'Users',
      content: 'a\r\n1\r\n',
    })
    expect(result).toEqual(expect.objectContaining({ status: 413 }))
  })

  it('passes on_conflict through to createRecords upsert handling', async () => {
    vi.mocked(findCollectionByNameInOrg).mockResolvedValue({ ...baseCollection, uniqueKey: ['name'] })
    selectLimit.mockResolvedValue([{ id: 7, data: { name: 'Alice', age: 1 } }])

    const result = await importRecords('user-test', 'org-test', {
      collection: 'Users',
      content: 'name,age\r\nAlice,30\r\n',
      on_conflict: 'skip',
    })

    expect(result).toEqual(expect.objectContaining({ count: 1, created: 0, updated: 0, skipped: 1 }))
  })

  it('returns 400 for CSV without a header row', async () => {
    const result = await importRecords('user-test', 'org-test', { collection: 'Users', content: '' })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('accepts a JSON array of objects', async () => {
    const result = await importRecords('user-test', 'org-test', {
      collection: 'Users',
      format: 'json',
      content: JSON.stringify([{ name: 'Alice' }, { name: 'Bob' }]),
    })

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ data: { name: 'Alice' } }),
      expect.objectContaining({ data: { name: 'Bob' } }),
    ])
    expect(result).toEqual(expect.objectContaining({ count: 2 }))
  })

  it('unwraps hutch_export_records JSON output so exports round-trip', async () => {
    insertReturning.mockResolvedValue([{ id: 1 }])
    const exported = JSON.stringify([
      { id: 9, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', data: { title: 'Hello' } },
    ])

    await importRecords('user-test', 'org-test', { collection: 'Users', format: 'json', content: exported })

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ data: { title: 'Hello' } }),
    ])
  })

  it('returns 400 for invalid JSON content', async () => {
    const result = await importRecords('user-test', 'org-test', {
      collection: 'Users',
      format: 'json',
      content: 'not json',
    })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('CSV export content round-trips through CSV import', async () => {
    // Export side
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: baseCollection, role: 'viewer',
    })
    vi.mocked(queryRecordsEngine).mockResolvedValue({
      records: [{
        id: 3,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-02-02T00:00:00.000Z'),
        data: { title: 'Widget, "deluxe"', price: 19.99, in_stock: true, meta: { color: 'red' }, notes: 'a\nb' },
      }],
      total: 1, count: 1, limit: 1000, offset: 0, has_more: false, next_offset: null,
    } as never)
    const exported = await exportRecords('users', 'user-test', { format: 'csv' })

    // Import side
    insertReturning.mockResolvedValue([{ id: 4 }])
    await importRecords('user-test', 'org-test', {
      collection: 'Users',
      content: (exported as { content: string }).content,
    })

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        data: { title: 'Widget, "deluxe"', price: 19.99, in_stock: true, meta: { color: 'red' }, notes: 'a\nb' },
      }),
    ])
  })
})
