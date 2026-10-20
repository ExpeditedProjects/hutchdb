import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: { execute: vi.fn() } }))

import { PgDialect } from 'drizzle-orm/pg-core'
import { compileQuery, summarizePlan, embeddedRecord } from './compiler'
import type { StorageRegistry } from './registry'

const dialect = new PgDialect()

const registry: StorageRegistry = {
  projections: [
    { field: 'price', column: 'p_price', type: 'number', reason: 'r' },
    { field: 'status', column: 'p_status', type: 'text', reason: 'r' },
    { field: 'active', column: 'p_active', type: 'boolean', reason: 'r' },
    { field: 'day', column: 'p_day', type: 'date', reason: 'r' },
  ],
  unwinds: [
    {
      path: 'votes',
      table: 'hc_12__votes',
      fields: [
        { field: 'category_id', column: 'p_category_id', type: 'number' },
        { field: 'label', column: 'p_label', type: 'text' },
        { field: 'points', column: 'p_points', type: 'number' },
      ],
      reason: 'r',
    },
  ],
  evaluated_rows: 0,
}

const collection = { id: 12, storage: registry }

function compile(params: Parameters<typeof compileQuery>[1]) {
  const compiled = compileQuery(collection, params)
  const { sql, params: bound } = dialect.sqlToQuery(compiled.query)
  return { compiled, sql: sql.replace(/\s+/g, ' ').trim(), params: bound }
}

describe('compileQuery: records', () => {
  it('reads from the collection table with the default sort and limits', () => {
    const { sql, params } = compile({})
    expect(sql).toContain('FROM "hc_12" t WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC, t.id DESC LIMIT $1 OFFSET $2')
    expect(params).toEqual([50, 0])
  })

  it('caps limit at 1000 like the shared layout, unless limitCap (export) raises it to at most 10000', () => {
    expect(compile({ limit: 50_000 }).params[0]).toBe(1000)
    expect(compile({ limit: 5000, limitCap: 10_000 }).params[0]).toBe(5000)
    expect(compile({ limit: 50_000, limitCap: 50_000 }).params[0]).toBe(10_000)
  })

  it('routes an equality on a projected field with a matching literal to the column', () => {
    const { sql, params } = compile({ filter: { price: 10 } })
    expect(sql).toContain('t."p_price" = $1::float8')
    expect(params[0]).toBe(10)
    expect(sql).not.toContain('@>')
  })

  it('routes comparison, $ne and $in to the column', () => {
    const { sql } = compile({ filter: { price: { $gte: 1, $lt: 5, $ne: 3 }, status: { $in: ['a', 'b'] } } })
    expect(sql).toContain('t."p_price" >= $1::float8')
    expect(sql).toContain('t."p_price" < $2::float8')
    expect(sql).toContain('t."p_price" IS DISTINCT FROM $3::float8')
    expect(sql).toContain('t."p_status" IN ($4::text, $5::text)')
  })

  it('falls back to the jsonb path on a mismatched literal type', () => {
    const { sql, params } = compile({ filter: { price: '10' } })
    expect(sql).toContain('t.data @> $1::jsonb')
    expect(params[0]).toBe('{"price":"10"}')
    expect(sql).not.toContain('p_price')
  })

  it('falls back to the jsonb path for $exists, $contains, null and undeclared fields', () => {
    const { sql } = compile({ filter: { price: { $exists: true }, status: { $contains: 'x' }, active: null, other: 1 } })
    expect(sql).toContain('t.data ? $')
    expect(sql).toContain('ILIKE')
    expect(sql).toContain('t.data @> $')
    expect(sql).not.toContain('p_active')
    expect(sql).not.toContain('p_status')
  })

  it('routes boolean and strict-date literals to their columns', () => {
    const { sql } = compile({ filter: { active: true, day: { $gte: '2026-01-01' } } })
    expect(sql).toContain('t."p_active" = $1::boolean')
    expect(sql).toContain('t."p_day" >= $2::date')
  })

  it('does not route a timestamp string to a date column', () => {
    const { sql } = compile({ filter: { day: '2026-01-01T00:00:00Z' } })
    expect(sql).not.toContain('p_day')
  })

  it('compiles conditions on an unwound path to one shared EXISTS over the child table', () => {
    const { sql, params } = compile({ filter: { 'votes.category_id': 3, 'votes.points': { $gt: 10 } } })
    expect(sql).toContain('EXISTS (SELECT 1 FROM "hc_12__votes" c WHERE c.parent_id = t.id AND c."p_category_id" = $1::float8 AND c."p_points" > $2::float8)')
    expect(params.slice(0, 2)).toEqual([3, 10])
    expect(sql.match(/EXISTS/g)).toHaveLength(1)
  })

  it('uses a jsonpath predicate for a dotted path into an array that is not unwound', () => {
    const compiled = compileQuery(collection, { filter: { 'items.sku': 'A1', 'items.qty': { $gte: 2 } } }, { arrayPaths: ['items'] })
    const { sql, params } = dialect.sqlToQuery(compiled.query)
    expect(sql).toContain('t.data @? $1::jsonpath')
    expect(params[0]).toBe('$."items"[*] ? (@."sku" == "A1" && @."qty" >= 2)')
    expect(sql).not.toContain('EXISTS')
  })

  it('compiles a dotted path into nested objects like the shared layout, without the literal-key fallback', () => {
    const { sql, params } = compile({ filter: { 'address.city': 'Oslo', 'address.zip': { $gte: '0100' } } })
    expect(sql).toContain('t.data @> $1::jsonb')
    expect(params[0]).toBe('{"address":{"city":"Oslo"}}')
    expect(sql).toContain("(jsonb_typeof(t.data #> $2::text[]) = 'string' AND (t.data #>> $3::text[]) >= $4)")
    expect(sql).not.toContain('jsonpath')
    expect(sql).not.toContain('coalesce')
  })

  it('uses jsonpath for a mismatched literal on an unwound column', () => {
    const { sql, params } = compile({ filter: { 'votes.category_id': 'three' } })
    expect(sql).not.toContain('EXISTS')
    expect(params[0]).toBe('$."votes"[*] ? (@."category_id" == "three")')
  })

  it('never puts filter values into the SQL text', () => {
    const evil = `'; DROP TABLE hc_12; --`
    const { sql } = compile({ filter: { [evil]: evil, 'votes.label': evil, [`votes.${evil}`]: { $contains: evil } } })
    expect(sql).not.toContain('DROP')
  })

  it('sorts on the projected column, else the jsonb value', () => {
    expect(compile({ sort: '-price' }).sql).toContain('ORDER BY t."p_price" DESC NULLS LAST')
    expect(compile({ sort: 'other' }).sql).toContain('ORDER BY t.data->$1::text ASC NULLS LAST')
  })

  it('keeps search and created_at bounds as in the shared layout', () => {
    const { sql } = compile({ search: 'hello', createdAfter: '2026-01-01', createdBefore: '2026-02-01' })
    expect(sql).toContain("to_tsvector('english', t.data::text) @@ plainto_tsquery('english', $1)")
    expect(sql).toContain('t.created_at >= $2::timestamptz')
    expect(sql).toContain('t.created_at < $3::timestamptz')
  })
})

describe('compileQuery: aggregation', () => {
  it('aggregates over the parent table using projected columns where available', () => {
    const { compiled, sql } = compile({ groupBy: 'status', aggregate: { total: { sum: 'price' }, n: 'count', top: { max: 'other' } } })
    expect(compiled.kind).toBe('aggregate')
    // Through text to numeric, so the sum is exactly the documents' sum.
    expect(sql).toContain('to_jsonb(sum(t."p_price"::text::numeric)) AS "total"')
    expect(sql).toContain('count(*)::int AS "n"')
    expect(sql).toContain('to_jsonb(max(CASE WHEN jsonb_typeof(t.data->$')
    expect(sql).toContain('t.data->>$1::text AS "status"')
    expect(sql).toContain('GROUP BY 1 ORDER BY 1 ASC')
    expect(sql).toContain('FROM "hc_12" t WHERE')
    expect(sql).not.toContain('parent_id')
  })

  it('runs nested aggregates against the child table, grouped by parent', () => {
    const { compiled, sql } = compile({
      filter: { status: 'open', 'votes.points': { $gt: 1 } },
      groupBy: 'votes.category_id',
      aggregate: { pts: { sum: 'votes.points' }, n: 'count' },
    })
    expect(compiled.kind === 'aggregate' && compiled.nested).toEqual({ path: 'votes', route: 'child' })
    expect(sql).toContain('SELECT t.id AS parent_id, to_jsonb(c."p_category_id") AS "votes.category_id", to_jsonb(sum(c."p_points"::text::numeric)) AS "pts", count(*)::int AS "n"')
    expect(sql).toContain('FROM "hc_12__votes" c JOIN "hc_12" t ON t.id = c.parent_id')
    expect(sql).toContain('t."p_status" = $1::text')
    expect(sql).toContain('c."p_points" > $2::float8')
    expect(sql).toContain('GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC')
    expect(sql).not.toContain('EXISTS')
  })

  it('unnests the array when the path is not unwound yet', () => {
    const compiled = compileQuery(collection, { groupBy: 'items.sku', aggregate: { q: { sum: 'items.qty' } } }, { arrayPaths: ['items'] })
    const sql = dialect.sqlToQuery(compiled.query).sql
    expect(compiled.kind === 'aggregate' && compiled.nested).toEqual({ path: 'items', route: 'lateral' })
    expect(sql).toContain('jsonb_array_elements(')
    expect(sql).toContain('WITH ORDINALITY e(val, ord)')
    expect(sql).toContain('e.val #> $')
  })

  it('rejects aggregates spanning two nested arrays or mixing levels', () => {
    expect(() => compileQuery(collection, { groupBy: 'votes.category_id', aggregate: { q: { sum: 'items.qty' } } }, { arrayPaths: ['items'] })).toThrow(/one nested array/)
    expect(() => compile({ groupBy: 'votes.category_id', aggregate: { q: { sum: 'price' } } })).toThrow(/one level at a time/)
  })

  it('validates field names and aggregation ops', () => {
    expect(() => compile({ groupBy: 'a;b' })).toThrow(/Invalid field name/)
    expect(() => compile({ aggregate: { x: { median: 'price' } } })).toThrow(/Unsupported aggregation/)
    // An unknown bucket falls back to 'day', as in the shared layout.
    expect(compile({ timeBucket: 'bogus', aggregate: { n: 'count' } }).sql).toContain("date_trunc('day', t.created_at) AS time_bucket")
  })
})

describe('summarizePlan', () => {
  const clauses = [{ label: 'filter on votes.category_id', indexes: ['hc_12__votes_p_category_id_idx'] }]

  it('reports the index node that serves a clause the caller wrote', () => {
    const report = summarizePlan(
      {
        'Node Type': 'Limit',
        Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'hc_12__votes_p_category_id_idx', 'Relation Name': 'hc_12__votes' }],
      },
      'hc_12',
      clauses,
    )
    expect(report).toEqual({ indexed: true, plan: 'Index Scan using hc_12__votes_p_category_id_idx' })
  })

  it('does not count system-side index use (unique key, primary key) as indexed', () => {
    const plan = {
      'Node Type': 'Limit',
      Plans: [{ 'Node Type': 'Bitmap Heap Scan', 'Relation Name': 'hc_12', Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'hc_12_uk' }] }],
    }
    const report = summarizePlan(plan, 'hc_12', [{ label: 'sort on totals.veterans.points', indexes: [] }])
    expect(report.indexed).toBe(false)
    expect(report.plan).toBe('Bitmap Heap Scan on hc_12')
    expect(report.reason).toMatch(/No index served sort on totals.veterans.points/)
    // The same index does count when the caller filtered on the unique key.
    expect(summarizePlan(plan, 'hc_12', [{ label: 'filter on slug', indexes: ['hc_12_uk'] }]).indexed).toBe(true)
  })

  it('explains a query with no clauses at all', () => {
    const report = summarizePlan({ 'Node Type': 'Seq Scan', 'Relation Name': 'hc_12' }, 'hc_12', [])
    expect(report).toEqual({ indexed: false, plan: 'Seq Scan on hc_12', reason: expect.stringMatching(/no filter, search or sort/) })
  })
})

describe('compileQuery: clauses for the indexed rule', () => {
  const clausesOf = (params: Parameters<typeof compileQuery>[1]) => compileQuery(collection, params).clauses

  it('names the projection, child, GIN, pkey, created_at and uk indexes per clause', () => {
    const withUk = { id: 12, storage: { ...registry, unique_key: ['slug'] } }
    const clauses = compileQuery(withUk, {
      filter: { price: 1, 'votes.category_id': 2, other: 'x', slug: 'abc', deep: { $gt: 1 } },
      createdAfter: '2026-01-01',
      sort: '-status',
    }).clauses
    expect(clauses).toEqual([
      { label: 'filter on price', indexes: ['hc_12_p_price_idx'] },
      { label: 'filter on votes.category_id', indexes: ['hc_12__votes_p_category_id_idx'] },
      { label: 'filter on other', indexes: ['hc_12_data_gin_idx'] },
      { label: 'filter on slug', indexes: ['hc_12_uk'] },
      { label: 'filter on deep ($gt)', indexes: [] },
      { label: 'created_after', indexes: ['hc_12_created_at_idx'] },
      { label: 'sort on status', indexes: ['hc_12_p_status_idx'] },
    ])
  })

  it('a plain list has no clauses; a default sort is not a clause', () => {
    expect(clausesOf({})).toEqual([])
    expect(clausesOf({ limit: 10, offset: 5 })).toEqual([])
  })

  it('a unique-key equality compiles to the uk column', () => {
    const withUk = { id: 12, storage: { ...registry, unique_key: ['slug'] } }
    const { sql } = dialect.sqlToQuery(compileQuery(withUk, { filter: { slug: 'abc' } }).query)
    expect(sql).toContain('t."uk_0" = $1::jsonb')
  })
})

describe('compileQuery: sort', () => {
  it('sorts on a dotted object path with jsonb typing', () => {
    const { sql, params } = compile({ sort: '-totals.veterans.points' })
    expect(sql).toContain('ORDER BY t.data #> $1::text[] DESC NULLS LAST')
    expect(params[0]).toBe('{"totals","veterans","points"}')
  })

  it('sorts on created_at with its index as the clause; id is a document field', () => {
    expect(compile({ sort: '-created_at' }).compiled.clauses).toEqual([{ label: 'sort on created_at', indexes: ['hc_12_created_at_idx'] }])
    expect(compile({ sort: 'id' }).sql).toContain('ORDER BY t.data->$1::text ASC NULLS LAST, t.id ASC')
  })

  it('rejects a sort on an array path in a records query', () => {
    expect(() => compile({ sort: '-votes.points' })).toThrow(/'votes' is an array of objects/)
    expect(() => compileQuery(collection, { sort: '-items.qty' }, { arrayPaths: ['items'] })).toThrow(/array of objects/)
  })

  it('rejects anything else by name, never falling back silently', () => {
    expect(() => compile({ sort: '-points' })).not.toThrow() // a plain field name is valid in a records query
    expect(() => compile({ sort: 'a;b' })).toThrow(/Invalid sort field 'a;b'/)
    expect(() => compile({ sort: '-' })).toThrow(/Invalid sort field/)
    expect(() => compile({ sort: 'a..b' })).toThrow(/Invalid sort field 'a..b'/)
  })

  it('in aggregate queries sorts by an alias or group key by ordinal, then limits', () => {
    const { sql } = compile({ groupBy: 'votes.category_id', aggregate: { points: { sum: 'votes.points' } }, sort: '-points', limit: 10 })
    expect(sql).toMatch(/ORDER BY 3 DESC NULLS LAST, 1 ASC, 2 ASC LIMIT \$\d+$/)
    expect(sql).toContain('count(*) OVER () AS __total')
    const byKey = compile({ groupBy: 'status', aggregate: { n: 'count' }, sort: 'status' }).sql
    expect(byKey).toMatch(/ORDER BY 1 ASC NULLS LAST LIMIT/)
  })

  it('rejects an aggregate sort that is neither an alias nor a group key', () => {
    expect(() => compile({ groupBy: 'votes.category_id', aggregate: { points: { sum: 'votes.points' } }, sort: '-votes.points' }))
      .toThrow(/Invalid sort field 'votes.points' for an aggregate query — sort accepts an aggregate alias or a group_by key here \(votes.category_id, points\)/)
    expect(() => compile({ aggregate: { n: 'count' }, sort: '-parent_id' })).toThrow(/Invalid sort field/)
  })
})

describe('compileQuery: deeper paths', () => {
  it('filters below an array element through jsonpath when the child has no column', () => {
    const { sql, params, compiled } = compile({ filter: { 'votes.points.veterans': { $gte: 1 } } })
    expect(sql).toContain('t.data @? $1::jsonpath')
    expect(params[0]).toBe('$."votes"[*] ? (@."points"."veterans" >= 1)')
    expect(sql).not.toContain('EXISTS')
    expect(compiled.clauses).toEqual([{ label: 'filter on votes.points.veterans ($gte)', indexes: [] }])
    // Equality can use the GIN index.
    expect(compile({ filter: { 'votes.points.veterans': 1 } }).compiled.clauses[0].indexes).toEqual(['hc_12_data_gin_idx'])
  })

  it('aggregates below an array element by unnesting the array (lateral), one level deep uses the child table', () => {
    const deep = compile({ groupBy: 'votes.category_id', aggregate: { v: { sum: 'votes.points.veterans' } } })
    expect(deep.compiled.kind === 'aggregate' && deep.compiled.nested).toEqual({ path: 'votes', route: 'lateral' })
    expect(deep.sql).toContain('e.val #> $')
    expect(deep.params).toContain('{"points","veterans"}')
    const shallow = compile({ groupBy: 'votes.category_id', aggregate: { v: { sum: 'votes.points' } } })
    expect(shallow.compiled.kind === 'aggregate' && shallow.compiled.nested).toEqual({ path: 'votes', route: 'child' })
  })

  it('treats a dotted path whose head is not an array as a nested object path', () => {
    const { sql, params, compiled } = compile({ groupBy: 'party', aggregate: { pts: { sum: 'totals.veterans.points' } } })
    expect(compiled.kind === 'aggregate' && compiled.nested).toBeNull()
    expect(sql).toContain('t.data #> $')
    expect(params).toContain('{"totals","veterans","points"}')
    expect(sql).not.toContain('parent_id')
  })

  it('a detected (not yet unwound) array head aggregates per parent via lateral', () => {
    const c = compileQuery(collection, { groupBy: 'items.sku', aggregate: { q: { sum: 'items.qty' } } }, { arrayPaths: ['items'] })
    expect(c.kind === 'aggregate' && c.nested).toEqual({ path: 'items', route: 'lateral' })
  })

  it('rejects two different arrays or mixing levels', () => {
    expect(() => compileQuery(collection, { groupBy: 'votes.category_id', aggregate: { q: { sum: 'items.qty' } } }, { arrayPaths: ['items'] })).toThrow(/one nested array/)
    expect(() => compile({ groupBy: 'votes.category_id', aggregate: { q: { sum: 'price' } } })).toThrow(/one level at a time/)
  })
})

describe('compileQuery: group_by with several keys', () => {
  it('groups by up to three keys named after the keys', () => {
    const { sql } = compile({ groupBy: ['votes.chamber', 'votes.label'], aggregate: { n: 'count' } })
    expect(sql).toContain('AS "votes.chamber"')
    expect(sql).toContain('AS "votes.label"')
    expect(sql).toContain('GROUP BY 1, 2, 3')
    const mixed = compile({ groupBy: ['status', 'votes.label'], aggregate: { n: 'count' } }).sql
    expect(mixed).toContain('t.data->>$')
    expect(mixed).toContain('to_jsonb(c."p_label") AS "votes.label"')
  })

  it('rejects more than three keys and keys on different arrays', () => {
    expect(() => compile({ groupBy: ['a', 'b', 'c', 'd'] })).toThrow(/at most 3 keys/)
    expect(() => compileQuery(collection, { groupBy: ['votes.label', 'items.sku'] }, { arrayPaths: ['items'] })).toThrow(/one nested array/)
  })
})

describe('embeddedRecord', () => {
  const rec = { id: 1, collectionId: 12, data: { name: 'A', n: 2, ok: true, nil: null, totals: { x: 1 }, votes: [{ a: 1 }] }, source: null, status: null, deletedAt: null, createdAt: null, updatedAt: null }

  it('keeps only top-level scalars when no fields are requested', () => {
    expect(embeddedRecord(rec, undefined).data).toEqual({ name: 'A', n: 2, ok: true, nil: null })
  })

  it('applies the requested fields, including nested objects', () => {
    expect(embeddedRecord(rec, ['name', 'totals']).data).toEqual({ name: 'A', totals: { x: 1 } })
  })
})
