import { describe, it, expect, vi, beforeEach } from 'vitest'

const { selectLimit, selectOffset, dbExecute } = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  selectOffset: vi.fn(),
  dbExecute: vi.fn(),
}))

// Drizzle's query builder is chainable: each clause returns an object with
// the next set of clauses. We mock it as a single recursive proxy so every
// chain ultimately resolves to the same `selectLimit` mock — tests don't
// have to care about the exact shape of the chain.
function buildChain(): any {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
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
  queryRecords,
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

describe('queryRecords aggregation', () => {
  it('routes through db.execute when groupBy is set', async () => {
    dbExecute.mockResolvedValue({ rows: [{ status: 'open', count: 3 }] })
    const result = await queryRecords({ collectionId: 1, groupBy: 'status' })
    expect(dbExecute).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ results: [{ status: 'open', count: 3 }] })
  })

  it('routes through db.execute when aggregate is set', async () => {
    dbExecute.mockResolvedValue({ rows: [{ count: 7 }] })
    await queryRecords({ collectionId: 1, aggregate: { count: 'count' } })
    expect(dbExecute).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid time_bucket value', async () => {
    await expect(queryRecords({ collectionId: 1, timeBucket: '; DROP TABLE records--' }))
      .rejects.toThrow()
  })

  it('rejects a groupBy field that sanitizes to empty', async () => {
    await expect(queryRecords({ collectionId: 1, groupBy: '!!!' }))
      .rejects.toThrow(/Invalid field name/)
  })
})
