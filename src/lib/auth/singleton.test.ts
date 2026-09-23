import { describe, it, expect, vi, beforeEach } from 'vitest'

const { userReturning, orgReturning, memberOnConflict, selectLimit } = vi.hoisted(() => ({
  userReturning: vi.fn(),
  orgReturning: vi.fn(),
  memberOnConflict: vi.fn(),
  selectLimit: vi.fn(),
}))

type MockChain = Record<string, unknown>

function buildSelectChain(): MockChain {
  const chain: MockChain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: selectLimit,
    then: (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(selectLimit()).then(onFulfilled, onRejected),
  }
  return chain
}

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => buildSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
        onConflictDoUpdate: vi.fn(() => ({
          returning: userReturning,
        })),
        returning: vi.fn(() => Promise.resolve([])),
      })),
    })),
    transaction: vi.fn(async (fn) =>
      fn({
        insert: (table: unknown) => ({
          values: () => {
            const isUser = String(table).toLowerCase().includes('user')
            const isOrg = String(table).toLowerCase().includes('organization') && !String(table).toLowerCase().includes('member')
            return {
              onConflictDoNothing: () => ({
                returning: vi.fn(() => Promise.resolve(isUser ? userReturning() : isOrg ? orgReturning() : [])),
              }),
              onConflictDoUpdate: () => ({
                returning: vi.fn(() => Promise.resolve(isUser ? userReturning() : isOrg ? orgReturning() : [])),
              }),
              returning: vi.fn(() => Promise.resolve(isUser ? userReturning() : isOrg ? orgReturning() : [])),
            }
          },
        }),
        select: () => buildSelectChain(),
      })
    ),
  },
}))

import { getSingletonContext } from './singleton'

beforeEach(() => {
  vi.clearAllMocks()
  selectLimit.mockReset().mockResolvedValue([])
  userReturning.mockReset().mockResolvedValue([{ id: 'user-singleton', email: 'singleton@local', name: 'Singleton' }])
  orgReturning.mockReset().mockResolvedValue([{ id: 'org-singleton', slug: 'personal', name: 'Personal', personal: true }])
  memberOnConflict.mockReset().mockResolvedValue(undefined)
})

describe('getSingletonContext', () => {
  it('returns an AuthContext shaped { userId, orgId }', async () => {
    const ctx = await getSingletonContext()
    expect(ctx).toEqual(expect.objectContaining({
      userId: expect.any(String),
      orgId: expect.any(String),
    }))
    expect(ctx.userId).toBeTruthy()
    expect(ctx.orgId).toBeTruthy()
  })

  it('is idempotent — repeated calls yield the same ids', async () => {
    const first = await getSingletonContext()
    const second = await getSingletonContext()
    const third = await getSingletonContext()
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('does not produce duplicate contexts under concurrent calls', async () => {
    const results = await Promise.all([
      getSingletonContext(),
      getSingletonContext(),
      getSingletonContext(),
      getSingletonContext(),
    ])
    const userIds = new Set(results.map((r) => r.userId))
    const orgIds = new Set(results.map((r) => r.orgId))
    expect(userIds.size).toBe(1)
    expect(orgIds.size).toBe(1)
  })

  it('resolves against a personal organization row', async () => {
    selectLimit.mockResolvedValue([
      { id: 'user-existing', email: 'x@y', name: 'X' },
    ])
    orgReturning.mockResolvedValue([{ id: 'org-existing', slug: 'personal', name: 'Personal', personal: true }])
    userReturning.mockResolvedValue([{ id: 'user-existing', email: 'x@y', name: 'X' }])

    const ctx = await getSingletonContext()
    expect(ctx.userId).toBeTruthy()
    expect(ctx.orgId).toBeTruthy()
  })
})
