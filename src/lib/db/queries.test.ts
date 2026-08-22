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

import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  findAccessibleCollectionBySlug,
  queryRecords,
  buildFilterConditions,
} from './queries'

// Serialize a drizzle SQL chunk to { sql, params } so tests can assert on
// the generated (fully parameterized) SQL without a live database.
const dialect = new PgDialect()
function render(chunk: SQL): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(chunk)
  return { sql, params }
}

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

describe('buildFilterConditions', () => {
  it('compiles a plain filter to a single containment condition (backwards compatible)', () => {
    const conditions = buildFilterConditions({ status: 'active', priority: 1 })
    expect(conditions).toHaveLength(1)
    const { sql, params } = render(conditions[0])
    expect(sql).toContain('@>')
    expect(params).toEqual([JSON.stringify({ status: 'active', priority: 1 })])
  })

  it('treats nested plain objects and arrays as containment, not operators', () => {
    const conditions = buildFilterConditions({ meta: { color: 'red' }, tags: ['a'] })
    expect(conditions).toHaveLength(1)
    const { params } = render(conditions[0])
    expect(params).toEqual([JSON.stringify({ meta: { color: 'red' }, tags: ['a'] })])
  })

  it('treats an object with mixed $ and plain keys as containment', () => {
    const conditions = buildFilterConditions({ f: { $gt: 1, plain: 2 } })
    expect(conditions).toHaveLength(1)
    expect(render(conditions[0]).sql).toContain('@>')
  })

  it('keeps containment first when plain and operator pairs are mixed', () => {
    const conditions = buildFilterConditions({ status: 'active', price: { $gte: 10 } })
    expect(conditions).toHaveLength(2)
    expect(render(conditions[0]).sql).toContain('@>')
    expect(render(conditions[1]).sql).toContain('jsonb_typeof')
  })

  describe('comparison operators ($gt/$gte/$lt/$lte)', () => {
    it('guards numeric operands with jsonb_typeof = number and casts to numeric', () => {
      const [cond] = buildFilterConditions({ price: { $gt: 5 } })
      const { sql, params } = render(cond)
      expect(sql).toMatch(/jsonb_typeof\("records"\."data"->\$\d+\) = 'number'/)
      expect(sql).toContain('::numeric >')
      expect(params).toEqual(['price', 'price', 5])
    })

    it('compares string operands lexicographically as text (mixed-type safe)', () => {
      const [cond] = buildFilterConditions({ due: { $lt: '2026-09-01' } })
      const { sql, params } = render(cond)
      expect(sql).toMatch(/jsonb_typeof\("records"\."data"->\$\d+\) = 'string'/)
      expect(sql).not.toContain('::numeric')
      expect(params).toContain('2026-09-01')
    })

    it('maps each operator to its SQL comparator', () => {
      const cases: [string, string][] = [['$gt', '>'], ['$gte', '>='], ['$lt', '<'], ['$lte', '<=']]
      for (const [op, symbol] of cases) {
        const [cond] = buildFilterConditions({ n: { [op]: 1 } })
        expect(render(cond).sql).toContain(`::numeric ${symbol} `)
      }
    })

    it('compiles a range spec ({$gte, $lt}) to two conditions', () => {
      const conditions = buildFilterConditions({ price: { $gte: 10, $lt: 100 } })
      expect(conditions).toHaveLength(2)
      expect(render(conditions[0]).sql).toContain('>=')
      expect(render(conditions[1]).sql).toContain('<')
    })

    it('rejects boolean/null/object operands', () => {
      expect(() => buildFilterConditions({ f: { $gt: true } })).toThrow(/\$gt/)
      expect(() => buildFilterConditions({ f: { $lte: null } })).toThrow(/\$lte/)
    })
  })

  describe('$ne', () => {
    it('negates containment (also matches records missing the field)', () => {
      const [cond] = buildFilterConditions({ status: { $ne: 'archived' } })
      const { sql, params } = render(cond)
      expect(sql).toMatch(/^NOT \(/i)
      expect(sql).toContain('@>')
      expect(params).toEqual([JSON.stringify({ status: 'archived' })])
    })
  })

  describe('$in / $nin', () => {
    it('$in compiles to = ANY over parameterized jsonb values', () => {
      const [cond] = buildFilterConditions({ status: { $in: ['active', 'pending'] } })
      const { sql, params } = render(cond)
      expect(sql).toContain('= ANY(ARRAY[')
      expect(params).toEqual(['status', '"active"', '"pending"'])
    })

    it('$in supports mixed value types safely (jsonb equality, no casts)', () => {
      const [cond] = buildFilterConditions({ f: { $in: [1, 'one', true] } })
      const { sql, params } = render(cond)
      expect(sql).not.toContain('::numeric')
      expect(params).toEqual(['f', '1', '"one"', 'true'])
    })

    it('$nin also matches records missing the field', () => {
      const [cond] = buildFilterConditions({ status: { $nin: ['archived'] } })
      const { sql } = render(cond)
      expect(sql).toContain('IS NULL OR NOT')
    })

    it('$in [] matches nothing; $nin [] matches everything', () => {
      expect(render(buildFilterConditions({ f: { $in: [] } })[0]).sql).toBe('false')
      expect(render(buildFilterConditions({ f: { $nin: [] } })[0]).sql).toBe('true')
    })

    it('rejects non-array operands', () => {
      expect(() => buildFilterConditions({ f: { $in: 'active' } })).toThrow(/array/)
    })
  })

  describe('$exists', () => {
    it('compiles true to the jsonb key-exists operator', () => {
      const [cond] = buildFilterConditions({ email: { $exists: true } })
      const { sql, params } = render(cond)
      expect(sql).toContain('?')
      expect(sql).not.toMatch(/^NOT/i)
      expect(params).toEqual(['email'])
    })

    it('compiles false to NOT key-exists', () => {
      const [cond] = buildFilterConditions({ email: { $exists: false } })
      expect(render(cond).sql).toMatch(/^NOT \(/i)
    })

    it('rejects non-boolean operands', () => {
      expect(() => buildFilterConditions({ f: { $exists: 'yes' } })).toThrow(/boolean/)
    })
  })

  describe('$contains', () => {
    it('compiles to a string-guarded case-insensitive ILIKE', () => {
      const [cond] = buildFilterConditions({ title: { $contains: 'widget' } })
      const { sql, params } = render(cond)
      expect(sql).toMatch(/jsonb_typeof\("records"\."data"->\$\d+\) = 'string'/)
      expect(sql).toContain('ILIKE')
      expect(params).toContain('%widget%')
    })

    it('escapes LIKE wildcards in the operand', () => {
      const [cond] = buildFilterConditions({ title: { $contains: '50%_off\\now' } })
      expect(render(cond).params).toContain('%50\\%\\_off\\\\now%')
    })

    it('rejects non-string operands', () => {
      expect(() => buildFilterConditions({ f: { $contains: 5 } })).toThrow(/string/)
    })
  })

  it('rejects unknown $-operators with the supported list', () => {
    expect(() => buildFilterConditions({ f: { $regex: 'x' } })).toThrow(/Unsupported filter operator '\$regex'/)
  })
})

describe('queryRecords field projection', () => {
  it('limits data to the requested top-level keys, keeping system columns', async () => {
    selectLimit.mockReturnValue({ offset: selectOffset })
    selectOffset.mockResolvedValue([
      {
        id: 1,
        collectionId: 1,
        status: 'active',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        data: { title: 'A', url: 'https://a.test', secret: 'hide-me' },
      },
    ])

    const result = await queryRecords({ collectionId: 1, fields: ['title', 'url'] })
    expect('records' in result && result.records[0]).toEqual(expect.objectContaining({
      id: 1,
      status: 'active',
      data: { title: 'A', url: 'https://a.test' },
    }))
  })

  it('omits requested keys absent from a record instead of inserting undefined', async () => {
    selectLimit.mockReturnValue({ offset: selectOffset })
    selectOffset.mockResolvedValue([
      { id: 1, data: { title: 'A' }, createdAt: new Date(), updatedAt: new Date() },
    ])

    const result = await queryRecords({ collectionId: 1, fields: ['title', 'missing'] })
    const record = ('records' in result ? result.records[0] : undefined) as { data: Record<string, unknown> }
    expect(record.data).toEqual({ title: 'A' })
    expect('missing' in record.data).toBe(false)
  })

  it('returns full data when fields is omitted (existing behavior)', async () => {
    selectLimit.mockReturnValue({ offset: selectOffset })
    selectOffset.mockResolvedValue([
      { id: 1, data: { a: 1, b: 2 }, createdAt: new Date(), updatedAt: new Date() },
    ])

    const result = await queryRecords({ collectionId: 1 })
    expect('records' in result && result.records[0].data).toEqual({ a: 1, b: 2 })
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

  describe('sum and avg', () => {
    async function aggregationSql(aggregate: Record<string, Record<string, string>>): Promise<string> {
      dbExecute.mockResolvedValue({ rows: [] })
      await queryRecords({ collectionId: 1, aggregate })
      return render(dbExecute.mock.calls[0][0]).sql
    }

    it('sum aggregates only numeric values via a jsonb_typeof guard', async () => {
      const sql = await aggregationSql({ revenue: { sum: 'amount' } })
      expect(sql).toContain(`sum(CASE WHEN jsonb_typeof(data->'amount') = 'number' THEN (data->>'amount')::numeric END) as "revenue"`)
    })

    it('avg aggregates only numeric values via a jsonb_typeof guard', async () => {
      const sql = await aggregationSql({ mean: { avg: 'price' } })
      expect(sql).toContain(`avg(CASE WHEN jsonb_typeof(data->'price') = 'number' THEN (data->>'price')::numeric END) as "mean"`)
    })

    it('sanitizes field and alias names in sum/avg specs', async () => {
      const sql = await aggregationSql({ 'x"; DROP TABLE records--': { sum: "a'; --" } })
      expect(sql).not.toContain('DROP TABLE')
      expect(sql).not.toContain("'; --")
    })

    it('existing min/max/distinct specs are unchanged', async () => {
      const sql = await aggregationSql({ latest: { max: 'created' } })
      expect(sql).toContain(`max(data->>'created') as "latest"`)
    })
  })
})
