import { describe, it, expect, vi, beforeEach } from 'vitest'

const { insertReturning, updateReturning, selectLimit, dbExecute, txSelectFor, txUpdateMock } = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  updateReturning: vi.fn(),
  selectLimit: vi.fn(),
  dbExecute: vi.fn(),
  txSelectFor: vi.fn(),
  txUpdateMock: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  })),
}))

vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: insertReturning })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: updateReturning })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([{ lastAt: '2026-01-01' }]), { limit: selectLimit })),
        innerJoin: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    execute: dbExecute,
    transaction: vi.fn((fn) => fn({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ for: txSelectFor })),
        })),
      })),
      update: txUpdateMock,
    })),
  },
}))

vi.mock('@/lib/db/queries', () => ({
  findAccessibleCollectionBySlug: vi.fn(),
  createCollectionWithOwner: vi.fn(),
  getCollectionRecordCount: vi.fn().mockResolvedValue(7),
  notDeleted: { __notDeleted: true },
}))

vi.mock('@/lib/describe', () => ({
  describeCollection: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/revalidation', () => ({
  revalidateDashboard: vi.fn(),
}))

vi.mock('@/lib/schema-inference', () => ({
  inferSchema: vi.fn().mockResolvedValue({ fields: [{ name: 'a', type: 'text' }], version: 1 }),
  mergeSchema: vi.fn((_, b) => b),
  isSelectableField: (f: { type: string }) => f.type === 'select' || f.type === 'multiselect',
  MAX_OPTION_VALUE_LENGTH: 50,
  MAX_OPTIONS_PER_FIELD: 50,
  SELECTABLE_FIELD_TYPES: ['select', 'multiselect'],
}))

vi.mock('./views', () => ({
  seedAutoViews: vi.fn().mockResolvedValue(undefined),
}))

import {
  createCollection,
  getCollection,
  updateCollection,
  deleteCollection,
  inferCollectionSchema,
  updateFieldDefinition,
  addFieldOption,
  addFieldDefinition,
  describeCollection,
  getCollectionStats,
} from './collections'
import { sortCollections } from '@/lib/collections/sort'
import { findAccessibleCollectionBySlug, createCollectionWithOwner } from '@/lib/db/queries'
import { seedAutoViews } from './views'

const baseCollection = {
  id: 1,
  apiKeyId: 1,
  organizationId: 'org-test',
  name: 'Bookmarks',
  slug: 'bookmarks',
  uniqueKey: [],
  schema: { fields: [{ name: 'url', type: 'text', position: 0, hidden: false, inferred: true }], version: 1, lastInferredAt: '' },
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

describe('createCollection', () => {
  it('uses uniqueSlug so identical names do not collide', async () => {
    vi.mocked(createCollectionWithOwner).mockResolvedValue(baseCollection)
    await createCollection('user-test', 'org-test', { name: 'Bookmarks' })
    const call = vi.mocked(createCollectionWithOwner).mock.calls[0][0]
    expect(call.slug).toMatch(/^bookmarks-[0-9a-f]{8}$/)
    expect(call.name).toBe('Bookmarks')
  })

  it('passes through schema, unique_key, and published', async () => {
    vi.mocked(createCollectionWithOwner).mockResolvedValue(baseCollection)
    await createCollection('user-test', 'org-test', {
      name: 'Bookmarks',
      schema: { fields: [{ name: 'url', type: 'text' }] },
      unique_key: ['url'],
      published: true,
    })
    const call = vi.mocked(createCollectionWithOwner).mock.calls[0][0]
    expect(call.schema).toEqual({ fields: [{ name: 'url', type: 'text' }] })
    expect(call.uniqueKey).toEqual(['url'])
    expect(call.published).toBe(true)
  })

  it('does NOT call seedAutoViews when no schema is supplied', async () => {
    vi.mocked(createCollectionWithOwner).mockResolvedValue(baseCollection)
    await createCollection('user-test', 'org-test', { name: 'Bookmarks' })
    expect(seedAutoViews).not.toHaveBeenCalled()
  })

  it('calls seedAutoViews when a schema with a select field is supplied', async () => {
    vi.mocked(createCollectionWithOwner).mockResolvedValue(baseCollection)
    const schema = {
      fields: [
        { name: 'status', type: 'select', inferred: true, position: 0, hidden: false, options: ['open', 'closed'] },
      ],
    }
    await createCollection('user-test', 'org-test', { name: 'Bookmarks', schema })

    expect(seedAutoViews).toHaveBeenCalledTimes(1)
    expect(seedAutoViews).toHaveBeenCalledWith(
      expect.stringMatching(/^bookmarks-[0-9a-f]{8}$/),
      'user-test',
      expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'status', type: 'select' }),
        ]),
      })
    )
  })
})

describe('getCollection', () => {
  it('returns null when the caller has no access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await getCollection('bookmarks', 'user-test')
    expect(result).toBeNull()
  })

  it('exposes the role on the returned collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'viewer' })
    selectLimit.mockResolvedValue([{ lastAt: '2026-01-01' }])
    const result = await getCollection('bookmarks', 'user-test')
    expect(result).toEqual(expect.objectContaining({ role: 'viewer', recordCount: 7 }))
  })
})

describe('updateCollection', () => {
  it('returns 404 when the caller is not an owner', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await updateCollection('bookmarks', 'user-test', { name: 'New Name' })
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })

  it('stamps publishedAt the first time published flips true', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'owner' })
    updateReturning.mockResolvedValue([{ ...baseCollection, published: true }])
    await updateCollection('bookmarks', 'user-test', { published: true })
    // Inspect the last db.update().set(...) call
    const setMock = (await import('@/lib/db')).db.update as unknown as ReturnType<typeof vi.fn>
    const setArgs = setMock.mock.results[0].value.set.mock.calls[0][0]
    expect(setArgs.published).toBe(true)
    expect(setArgs.publishedAt).toBeInstanceOf(Date)
  })

  it('does not re-stamp publishedAt when already published', async () => {
    const alreadyPublished = { ...baseCollection, publishedAt: new Date('2025-01-01') }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: alreadyPublished, role: 'owner' })
    updateReturning.mockResolvedValue([alreadyPublished])
    await updateCollection('bookmarks', 'user-test', { published: true })
    const setMock = (await import('@/lib/db')).db.update as unknown as ReturnType<typeof vi.fn>
    const setArgs = setMock.mock.results[0].value.set.mock.calls[0][0]
    expect(setArgs.publishedAt).toBeUndefined()
  })
})

describe('deleteCollection', () => {
  it('returns 404 when the caller is not an owner', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await deleteCollection('bookmarks', 'user-test')
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })

  it('returns deleted: true on success', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'owner' })
    const result = await deleteCollection('bookmarks', 'user-test')
    expect(result).toEqual({ deleted: true, slug: 'bookmarks' })
  })
})

describe('inferCollectionSchema', () => {
  it('returns null when the caller is not at least an editor', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await inferCollectionSchema('bookmarks', 'user-test')
    expect(result).toBeNull()
  })
})

describe('updateFieldDefinition', () => {
  it('returns null when the caller is not at least an editor', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await updateFieldDefinition('bookmarks', 'user-test', 'url', { hidden: true })
    expect(result).toBeNull()
  })

  it('returns 404 when the field does not exist in the schema', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    const result = await updateFieldDefinition('bookmarks', 'user-test', 'nope', { hidden: true })
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })

  it('marks the updated field as not inferred and bumps schema version', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: { ...baseCollection }, role: 'editor' })
    const result = await updateFieldDefinition('bookmarks', 'user-test', 'url', { hidden: true })
    expect(result).toEqual({ field: expect.objectContaining({ name: 'url', hidden: true, inferred: false }) })
  })
})

describe('describeCollection', () => {
  it('returns null when the caller has no access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await describeCollection('bookmarks', 'user-test')
    expect(result).toBeNull()
  })

  it('returns name, slug, recordCount, and fields when accessible', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'viewer' })
    const result = await describeCollection('bookmarks', 'user-test')
    expect(result).toEqual(expect.objectContaining({
      name: 'Bookmarks',
      slug: 'bookmarks',
      recordCount: 7,
    }))
  })
})

describe('addFieldOption', () => {
  const baseSchema = {
    fields: [
      {
        name: 'status',
        type: 'select',
        position: 0,
        hidden: false,
        inferred: true,
        options: ['open', 'closed'],
      },
      {
        name: 'title',
        type: 'text',
        position: 1,
        hidden: false,
        inferred: true,
      },
    ],
    version: 3,
    lastInferredAt: '',
  }

  function mockSchema(schema: typeof baseSchema | { fields: typeof baseSchema.fields; version: number; lastInferredAt: string }) {
    txSelectFor.mockResolvedValue([{ schema: structuredClone(schema) }])
  }

  it('returns null when the caller is not at least an editor', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await addFieldOption('bookmarks', 'user-test', 'status', 'in_progress')
    expect(result).toBeNull()
  })

  it('returns 404 when the field does not exist in the schema', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    mockSchema(baseSchema)
    const result = await addFieldOption('bookmarks', 'user-test', 'nope', 'in_progress')
    expect(result).toEqual(expect.objectContaining({ status: 404, error: 'Field not found in schema' }))
  })

  it('returns 400 when the field is not select or multiselect', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    mockSchema(baseSchema)
    const result = await addFieldOption('bookmarks', 'user-test', 'title', 'whatever')
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
    expect((result as { error: string }).error).toMatch(/text/)
  })

  it('returns 400 for whitespace-only values (before any DB lookup)', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    const result = await addFieldOption('bookmarks', 'user-test', 'status', '   ')
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('returns 400 for values longer than 50 chars (before any DB lookup)', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    const result = await addFieldOption('bookmarks', 'user-test', 'status', 'x'.repeat(51))
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('is idempotent when the value already exists in options (no tx.update call)', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    mockSchema(baseSchema)

    const result = await addFieldOption('bookmarks', 'user-test', 'status', 'open')

    expect(result).toEqual({ field: expect.objectContaining({ name: 'status', options: ['open', 'closed'] }) })
    expect(txUpdateMock).not.toHaveBeenCalled()
  })

  it('takes the cached fast-path (no transaction) when the cached schema already contains the value', async () => {
    const cached = {
      ...baseCollection,
      schema: structuredClone(baseSchema),
    }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: cached, role: 'editor' })

    const result = await addFieldOption('bookmarks', 'user-test', 'status', 'open')

    expect(result).toEqual({ field: expect.objectContaining({ name: 'status', options: ['open', 'closed'] }) })
    expect(txSelectFor).not.toHaveBeenCalled()
    expect(txUpdateMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the field already has 50 options (cap)', async () => {
    const tooManyOptions = Array.from({ length: 50 }, (_, i) => `opt_${i}`)
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    mockSchema({
      ...baseSchema,
      fields: [
        { ...baseSchema.fields[0], options: tooManyOptions },
        baseSchema.fields[1],
      ],
    })
    const result = await addFieldOption('bookmarks', 'user-test', 'status', 'one_more')
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
    expect((result as { error: string }).error).toMatch(/maximum/i)
  })

  it('appends the trimmed value, sets inferred:false, bumps version, and returns the updated field', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'editor' })
    mockSchema(baseSchema)

    const result = await addFieldOption('bookmarks', 'user-test', 'status', '  in_progress  ')

    expect(result).toEqual({
      field: expect.objectContaining({
        name: 'status',
        options: ['open', 'closed', 'in_progress'],
        inferred: false,
      }),
    })

    expect(txUpdateMock).toHaveBeenCalled()
    const setArgs = txUpdateMock.mock.results[0].value.set.mock.calls[0][0]
    expect(setArgs.schema.version).toBe(4)
    const updatedField = setArgs.schema.fields.find((f: { name: string }) => f.name === 'status')
    expect(updatedField.options).toEqual(['open', 'closed', 'in_progress'])
    expect(updatedField.inferred).toBe(false)
  })
})

describe('addFieldDefinition', () => {
  const baseSchema = {
    fields: [
      {
        name: 'status',
        type: 'select',
        position: 0,
        hidden: false,
        inferred: true,
        options: ['open', 'closed'],
      },
      {
        name: 'title',
        type: 'text',
        position: 3,
        hidden: false,
        inferred: true,
      },
    ],
    version: 5,
    lastInferredAt: '',
  }

  it('adds a new select field with empty options when the name is valid and unique', async () => {
    const collection = { ...baseCollection, schema: structuredClone(baseSchema) }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection, role: 'editor' })
    txSelectFor.mockResolvedValue([{ schema: structuredClone(baseSchema) }])

    const result = await addFieldDefinition('bookmarks', 'user-test', 'priority')

    expect(result).toEqual({
      field: expect.objectContaining({
        name: 'priority',
        type: 'select',
        options: [],
        inferred: false,
        hidden: false,
      }),
    })
  })

  it('returns 400 for an invalid field name (contains hyphen or space)', async () => {
    const collection = { ...baseCollection, schema: structuredClone(baseSchema) }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection, role: 'editor' })

    const hyphen = await addFieldDefinition('bookmarks', 'user-test', 'my-field')
    expect(hyphen).toEqual(expect.objectContaining({ status: 400 }))

    const space = await addFieldDefinition('bookmarks', 'user-test', 'my field')
    expect(space).toEqual(expect.objectContaining({ status: 400 }))

    const empty = await addFieldDefinition('bookmarks', 'user-test', '')
    expect(empty).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('returns 409 when a field with that name already exists', async () => {
    const collection = { ...baseCollection, schema: structuredClone(baseSchema) }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection, role: 'editor' })
    txSelectFor.mockResolvedValue([{ schema: structuredClone(baseSchema) }])

    const result = await addFieldDefinition('bookmarks', 'user-test', 'status')

    expect(result).toEqual(expect.objectContaining({ status: 409 }))
  })

  it('returns null when the collection is not found or the apiKey lacks access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)

    const result = await addFieldDefinition('bookmarks', 'user-test', 'priority')

    expect(result).toBeNull()
  })

  it('returns 400 when the field name exceeds the max length', async () => {
    const collection = { ...baseCollection, schema: structuredClone(baseSchema) }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection, role: 'editor' })

    const tooLong = 'a'.repeat(65)
    const result = await addFieldDefinition('bookmarks', 'user-test', tooLong)
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
  })

  it('assigns position as max existing position + 1', async () => {
    const collection = { ...baseCollection, schema: structuredClone(baseSchema) }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection, role: 'editor' })
    txSelectFor.mockResolvedValue([{ schema: structuredClone(baseSchema) }])

    const result = await addFieldDefinition('bookmarks', 'user-test', 'priority')

    expect(result).toEqual({
      field: expect.objectContaining({ name: 'priority', position: 4 }),
    })
  })
})

describe('sortCollections', () => {
  type SortRow = {
    name: string
    role: 'owner' | 'editor' | 'viewer'
    recordCount: number
    lastRecordAt: string | null
    updatedAt: Date
  }

  const rows: SortRow[] = [
    { name: 'bananas', role: 'editor', recordCount: 9, lastRecordAt: '2026-01-03T00:00:00Z', updatedAt: new Date('2026-01-03') },
    { name: 'Apples', role: 'owner', recordCount: 10, lastRecordAt: null, updatedAt: new Date('2026-01-02') },
    { name: 'cherries', role: 'viewer', recordCount: 2, lastRecordAt: '2026-01-01T00:00:00Z', updatedAt: new Date('2026-01-01') },
  ]

  it('sorts by name asc, case-insensitively', () => {
    const sorted = sortCollections(rows, 'name', 'asc')
    expect(sorted.map((r) => r.name)).toEqual(['Apples', 'bananas', 'cherries'])
  })

  it('sorts by name desc, case-insensitively', () => {
    const sorted = sortCollections(rows, 'name', 'desc')
    expect(sorted.map((r) => r.name)).toEqual(['cherries', 'bananas', 'Apples'])
  })

  it('sorts by recordCount numerically (10 > 9, not lexicographic)', () => {
    const sorted = sortCollections(rows, 'recordCount', 'desc')
    expect(sorted.map((r) => r.recordCount)).toEqual([10, 9, 2])
  })

  it('sorts by lastRecordAt desc with nulls always last', () => {
    const sorted = sortCollections(rows, 'lastRecordAt', 'desc')
    expect(sorted.map((r) => r.name)).toEqual(['bananas', 'cherries', 'Apples'])
  })

  it('sorts by lastRecordAt asc with nulls also last', () => {
    const sorted = sortCollections(rows, 'lastRecordAt', 'asc')
    expect(sorted.map((r) => r.name)).toEqual(['cherries', 'bananas', 'Apples'])
  })

  it('falls back to lastRecordAt desc when sortBy is unknown', () => {
    const sorted = sortCollections(rows, 'banana' as never, 'desc')
    expect(sorted.map((r) => r.name)).toEqual(['bananas', 'cherries', 'Apples'])
  })

  it('does not mutate the input array', () => {
    const input: SortRow[] = [
      { name: 'B', role: 'owner', recordCount: 1, lastRecordAt: '2026-01-02T00:00:00Z', updatedAt: new Date('2026-01-02') },
      { name: 'A', role: 'owner', recordCount: 2, lastRecordAt: '2026-01-01T00:00:00Z', updatedAt: new Date('2026-01-01') },
    ]
    const before = input.slice()
    sortCollections(input, 'name', 'asc')
    expect(input).toEqual(before)
  })
})

describe('getCollectionStats', () => {
  function mockStatsQueries() {
    // Order matches the Promise.all in getCollectionStats: summary, status, fields.
    dbExecute
      .mockResolvedValueOnce({
        rows: [{
          record_count: 4,
          first_created_at: '2026-01-01 00:00:00+00',
          last_created_at: '2026-02-01 00:00:00+00',
          first_updated_at: '2026-01-01 00:00:00+00',
          last_updated_at: '2026-02-02 00:00:00+00',
          approx_storage_bytes: '2048', // pg returns bigint as string
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { status: 'active', count: 3 },
          { status: 'archived', count: 1 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { key: 'url', count: 4 },
          { key: 'title', count: 3 },
          { key: 'notes', count: 1 },
        ],
      })
  }

  it('returns null when the caller has no access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await getCollectionStats('bookmarks', 'user-test')
    expect(result).toBeNull()
    expect(dbExecute).not.toHaveBeenCalled()
  })

  it('returns counts, timestamps, storage bytes, and per-field fill rates', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'viewer' })
    mockStatsQueries()

    const result = await getCollectionStats('bookmarks', 'user-test')

    expect(result).toEqual({
      name: 'Bookmarks',
      slug: 'bookmarks',
      record_count: 4,
      by_status: { active: 3, archived: 1 },
      first_created_at: '2026-01-01 00:00:00+00',
      last_created_at: '2026-02-01 00:00:00+00',
      first_updated_at: '2026-01-01 00:00:00+00',
      last_updated_at: '2026-02-02 00:00:00+00',
      approx_storage_bytes: 2048,
      fields: [
        { name: 'url', count: 4, percent: 100 },
        { name: 'title', count: 3, percent: 75 },
        { name: 'notes', count: 1, percent: 25 },
      ],
    })
  })

  it('handles an empty collection without dividing by zero', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({ organization: mockOrg, collection: baseCollection, role: 'viewer' })
    dbExecute
      .mockResolvedValueOnce({
        rows: [{
          record_count: 0,
          first_created_at: null,
          last_created_at: null,
          first_updated_at: null,
          last_updated_at: null,
          approx_storage_bytes: '0',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await getCollectionStats('bookmarks', 'user-test')

    expect(result).toEqual(expect.objectContaining({
      record_count: 0,
      by_status: {},
      first_created_at: null,
      last_created_at: null,
      approx_storage_bytes: 0,
      fields: [],
    }))
  })
})
