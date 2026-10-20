import { describe, it, expect, vi, beforeEach } from 'vitest'

const { selectLimit, selectOffset, dbExecute, orderByCapture } = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  selectOffset: vi.fn(),
  dbExecute: vi.fn(),
  orderByCapture: vi.fn(),
}))

// Drizzle's query builder is chainable: each clause returns an object with
// the next set of clauses. We mock it as a single recursive proxy so every
// chain ultimately resolves to the same `selectLimit` mock — tests don't
// have to care about the exact shape of the chain.
type MockChain = Record<string, unknown>

function buildChain(): MockChain {
  const chain: MockChain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    orderBy: vi.fn((clause) => {
      orderByCapture(clause)
      return chain
    }),
    limit: selectLimit,
  }
  return chain
}

vi.mock('./index', () => ({
  db: {
    select: vi.fn(() => buildChain()),
    execute: dbExecute,
  },
}))

import {
  findAccessibleCollectionBySlug,
  normalizeGroupBy,
} from './queries'

const collectionRow = {
  id: 1,
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

beforeEach(() => {
  vi.clearAllMocks()
  selectLimit.mockReset()
  selectOffset.mockReset()
  dbExecute.mockReset()
})

describe('findAccessibleCollectionBySlug', () => {
  it('returns undefined when no userId is supplied (no auth)', async () => {
    const result = await findAccessibleCollectionBySlug('bookmarks', '', 'viewer')
    expect(result).toBeUndefined()
  })

  it('returns undefined when query returns nothing', async () => {
    selectLimit.mockResolvedValue([])
    const result = await findAccessibleCollectionBySlug('bookmarks', 'u1')
    expect(result).toBeUndefined()
  })

  it('returns undefined when neither explicit nor org access applies', async () => {
    selectLimit.mockResolvedValue([{ collection: collectionRow, memberRole: null, orgMemberRole: null }])
    const result = await findAccessibleCollectionBySlug('bookmarks', 'u1', 'viewer')
    expect(result).toBeUndefined()
  })

  it('returns undefined when the user role is below the required minimum', async () => {
    selectLimit.mockResolvedValue([{ collection: collectionRow, memberRole: 'viewer', orgMemberRole: null }])
    const result = await findAccessibleCollectionBySlug('bookmarks', 'u1', 'owner')
    expect(result).toBeUndefined()
  })

  it('returns the collection when the user role meets the minimum', async () => {
    selectLimit.mockResolvedValue([{ collection: collectionRow, memberRole: 'owner', orgMemberRole: null }])
    const result = await findAccessibleCollectionBySlug('bookmarks', 'u1', 'editor')
    expect(result?.role).toBe('owner')
  })

  it('grants viewer access via visibility=org default', async () => {
    selectLimit.mockResolvedValue([{
      collection: { ...collectionRow, visibility: 'org', orgDefaultRole: 'viewer' },
      memberRole: null,
      orgMemberRole: 'member',
    }])
    const result = await findAccessibleCollectionBySlug('bookmarks', 'u1', 'viewer')
    expect(result?.role).toBe('viewer')
  })

  it('org admin gets owner on private collections too', async () => {
    selectLimit.mockResolvedValue([{
      collection: collectionRow,
      memberRole: null,
      orgMemberRole: 'admin',
    }])
    const result = await findAccessibleCollectionBySlug('bookmarks', 'u1', 'owner')
    expect(result?.role).toBe('owner')
  })
})

describe('normalizeGroupBy', () => {
  it('accepts a string, an array of up to 3 keys, and dotted paths', () => {
    expect(normalizeGroupBy(undefined)).toEqual([])
    expect(normalizeGroupBy('status')).toEqual(['status'])
    expect(normalizeGroupBy(['a', 'b.c', 'd.e.f'])).toEqual(['a', 'b.c', 'd.e.f'])
  })

  it('rejects more than 5 keys and invalid names', () => {
    expect(normalizeGroupBy(['a', 'b', 'c', 'd', 'e'])).toHaveLength(5)
    expect(() => normalizeGroupBy(['a', 'b', 'c', 'd', 'e', 'f'])).toThrow(/at most 5 keys/)
    expect(() => normalizeGroupBy(['a', "b'; --"])).toThrow(/Invalid field name/)
  })
})
