import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Failing spec (TDD): deleteCollection (src/lib/services/collections.ts) must
// call cleanupCollectionBlobs (src/lib/services/files.ts) BEFORE hard-deleting
// the collection row, so orphaned blobs never accumulate in storage.
// Lives in its own file because collections.test.ts imports the real service
// while this spec needs './files' mocked.
// ---------------------------------------------------------------------------

const { cleanupCollectionBlobs, dbDelete } = vi.hoisted(() => ({
  cleanupCollectionBlobs: vi.fn().mockResolvedValue(undefined),
  dbDelete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
}))

vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn().mockResolvedValue([]) })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), { limit: vi.fn().mockResolvedValue([]) })),
      })),
    })),
    delete: dbDelete,
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@/lib/db/queries', () => ({
  findAccessibleCollectionBySlug: vi.fn(),
  createCollectionWithOwner: vi.fn(),
  getCollectionRecordCount: vi.fn().mockResolvedValue(0),
  notDeleted: { __notDeleted: true },
}))

vi.mock('@/lib/describe', () => ({
  describeCollection: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/revalidation', () => ({
  revalidateDashboard: vi.fn(),
}))

vi.mock('@/lib/schema-inference', () => ({
  inferSchema: vi.fn().mockResolvedValue({ fields: [], version: 1 }),
  mergeSchema: vi.fn((_, b) => b),
  isSelectableField: (f: { type: string }) => f.type === 'select' || f.type === 'multiselect',
  MAX_OPTION_VALUE_LENGTH: 50,
  MAX_OPTIONS_PER_FIELD: 50,
  SELECTABLE_FIELD_TYPES: ['select', 'multiselect'],
}))

vi.mock('./views', () => ({
  seedAutoViews: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./files', () => ({
  putFile: vi.fn(),
  getFile: vi.fn(),
  listFiles: vi.fn(),
  deleteFile: vi.fn(),
  cleanupCollectionBlobs,
}))

import { deleteCollection } from './collections'
import { findAccessibleCollectionBySlug } from '@/lib/db/queries'

const baseCollection = {
  id: 1,
  apiKeyId: 1,
  organizationId: 'org-test',
  name: 'Bookmarks',
  slug: 'bookmarks',
  uniqueKey: [],
  schema: { fields: [], version: 1, lastInferredAt: '' },
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
  cleanupCollectionBlobs.mockResolvedValue(undefined)
})

describe('deleteCollection blob cleanup', () => {
  it('cleans up the collection blobs before hard-deleting the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: baseCollection, role: 'owner',
    } as never)

    const result = await deleteCollection('bookmarks', 'user-test')

    expect(result).toEqual({ deleted: true, slug: 'bookmarks' })
    expect(cleanupCollectionBlobs).toHaveBeenCalledWith(baseCollection.id)
    // Blob cleanup happens BEFORE the row delete (the record rows — and their
    // blob_keys — are gone once the collection cascades away).
    expect(cleanupCollectionBlobs.mock.invocationCallOrder[0]).toBeLessThan(
      dbDelete.mock.invocationCallOrder[0]
    )
  })

  it('does not touch storage when the caller is not an owner', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)

    const result = await deleteCollection('bookmarks', 'user-test')

    expect(result).toEqual(expect.objectContaining({ status: 404 }))
    expect(cleanupCollectionBlobs).not.toHaveBeenCalled()
    expect(dbDelete).not.toHaveBeenCalled()
  })
})
