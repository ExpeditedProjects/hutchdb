import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: { execute: vi.fn() } }))

import { PgDialect } from 'drizzle-orm/pg-core'
import { compileQuery, summarizePlan, sortKeys, typeCheckWarnings } from './compiler'
import type { StorageRegistry } from './registry'
import { ClientInputError } from '@/lib/errors/client-input-error'

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

  it('caps limit at 1000, unless limitCap (export) raises it to at most 10000', () => {
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

  it('serves $exists from an unmixed projection; falls back to the jsonb path for $contains, null and undeclared fields', () => {
    const { sql } = compile({ filter: { price: { $exists: true }, status: { $contains: 'x' }, active: null, other: 1 } })
    expect(sql).toContain('t."p_price" IS NOT NULL')
    expect(compile({ filter: { other: { $exists: true } } }).sql).toContain('t.data ? $')
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

  it('compiles a dotted path into nested objects, without a literal-key fallback', () => {
    const { sql, params } = compile({ filter: { 'address.city': 'Oslo', 'address.zip': { $gte: '0100' } } })
    // Equality also matches an array holding the value (Mongo semantics).
    expect(sql).toContain('(t.data @> $1::jsonb OR t.data @> $2::jsonb)')
    expect(params.slice(0, 2)).toEqual(['{"address":{"city":"Oslo"}}', '{"address":{"city":["Oslo"]}}'])
    expect(sql).toContain("(jsonb_typeof(t.data #> $3::text[]) = 'string' AND (t.data #>> $4::text[]) >= $5)")
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
    // Descending runs as two parts so the ASC btree serves it backwards.
    expect(compile({ sort: '-price' }).sql).toContain('t."p_price" IS NOT NULL ORDER BY t."p_price" DESC, t.id ASC')
    expect(compile({ sort: 'price' }).sql).toContain('ORDER BY t."p_price" ASC NULLS LAST')
    expect(compile({ sort: 'other' }).sql).toContain('ORDER BY t.data->$1::text ASC NULLS LAST')
  })

  it('compiles search and created_at bounds', () => {
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
    expect(sql).toContain('to_jsonb(bool_or(CASE WHEN jsonb_typeof(t.data->$')
    // Group keys keep their JSON type; the unmixed projection serves them.
    expect(sql).toContain(`NULLIF(to_jsonb(t."p_status"), 'null'::jsonb) AS "status"`)
    expect(sql).toContain('GROUP BY 1 ORDER BY 1 ASC')
    expect(sql).toContain('FROM "hc_12" t WHERE')
    expect(sql).not.toContain('parent_id')
  })

  it('runs nested aggregates against the child table, grouped by parent with perRecord', () => {
    const { compiled, sql } = compile({
      filter: { status: 'open', 'votes.points': { $gt: 1 } },
      groupBy: 'votes.category_id',
      aggregate: { pts: { sum: 'votes.points' }, n: 'count' },
      perRecord: true,
    })
    expect(compiled.kind === 'aggregate' && compiled.nested).toEqual({ path: 'votes', route: 'child' })
    expect(sql).toContain(`SELECT t.id AS parent_id, NULLIF(to_jsonb(c."p_category_id"), 'null'::jsonb) AS "votes.category_id", to_jsonb(sum(c."p_points"::text::numeric)) AS "pts"`)
    expect(sql).toContain('FROM "hc_12__votes" c JOIN "hc_12" t ON t.id = c.parent_id')
    expect(sql).toContain('t."p_status" = $1::text')
    expect(sql).toContain('c."p_points" > $2::float8')
    expect(sql).toContain('GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC')
    expect(sql).not.toContain('EXISTS')
  })

  it('totals a nested aggregate across parents unless perRecord asks for parent rows', () => {
    const { compiled, sql } = compile({ groupBy: 'votes.category_id', aggregate: { pts: { sum: 'votes.points' }, n: 'count' } })
    expect(compiled.kind === 'aggregate' && compiled.nested).toBeNull()
    expect(sql).not.toContain('AS parent_id')
    expect(sql).toContain('FROM "hc_12__votes" c JOIN "hc_12" t ON t.id = c.parent_id')
    expect(sql).toContain('GROUP BY 1 ORDER BY 1 ASC')
  })

  it('unnests the array when the path is not unwound yet', () => {
    const compiled = compileQuery(collection, { groupBy: 'items.sku', aggregate: { q: { sum: 'items.qty' } }, perRecord: true }, { arrayPaths: ['items'] })
    const sql = dialect.sqlToQuery(compiled.query).sql
    expect(compiled.kind === 'aggregate' && compiled.nested).toEqual({ path: 'items', route: 'lateral' })
    expect(sql).toContain('jsonb_array_elements(')
    expect(sql).toContain('WITH ORDINALITY e(val, ord)')
    expect(sql).toContain('e.val #> $')
  })

  it('rejects aggregates spanning two nested arrays; parent fields aggregate per element', () => {
    expect(() => compileQuery(collection, { groupBy: 'votes.category_id', aggregate: { q: { sum: 'items.qty' } } }, { arrayPaths: ['items'] })).toThrow(/one nested array/)
    const { sql } = compile({ groupBy: 'votes.category_id', aggregate: { q: { sum: 'price' } } })
    expect(sql).toContain('to_jsonb(sum(t."p_price"::text::numeric)) AS "q"')
    expect(sql).toContain('FROM "hc_12__votes" c JOIN "hc_12" t ON t.id = c.parent_id')
  })

  it('validates field names and aggregation ops', () => {
    expect(() => compile({ groupBy: 'a;b' })).toThrow(/Invalid field name/)
    expect(() => compile({ aggregate: { x: { median: 'price' } } })).toThrow(/Unsupported aggregation/)
    // An unknown bucket falls back to 'day'.
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
    expect(report.reason).toMatch(/No index can serve sort on totals.veterans.points/)
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
    expect(sql).toMatch(/ORDER BY 2 DESC NULLS LAST, 1 ASC LIMIT \$\d+ OFFSET \$\d+$/)
    expect(compile({ groupBy: 'votes.category_id', aggregate: { points: { sum: 'votes.points' } }, sort: '-points', perRecord: true }).sql)
      .toMatch(/ORDER BY 3 DESC NULLS LAST, 1 ASC, 2 ASC LIMIT \$\d+ OFFSET \$\d+$/)
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
    const deep = compile({ groupBy: 'votes.category_id', aggregate: { v: { sum: 'votes.points.veterans' } }, perRecord: true })
    expect(deep.compiled.kind === 'aggregate' && deep.compiled.nested).toEqual({ path: 'votes', route: 'lateral' })
    expect(deep.sql).toContain('e.val #> $')
    expect(deep.params).toContain('{"points","veterans"}')
    const shallow = compile({ groupBy: 'votes.category_id', aggregate: { v: { sum: 'votes.points' } }, perRecord: true })
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
    const c = compileQuery(collection, { groupBy: 'items.sku', aggregate: { q: { sum: 'items.qty' } }, perRecord: true }, { arrayPaths: ['items'] })
    expect(c.kind === 'aggregate' && c.nested).toEqual({ path: 'items', route: 'lateral' })
  })

  it('rejects two different arrays', () => {
    expect(() => compileQuery(collection, { groupBy: 'votes.category_id', aggregate: { q: { sum: 'items.qty' } } }, { arrayPaths: ['items'] })).toThrow(/one nested array/)
  })
})

describe('compileQuery: group_by with several keys', () => {
  it('groups by up to three keys named after the keys', () => {
    const { sql } = compile({ groupBy: ['votes.chamber', 'votes.label'], aggregate: { n: 'count' } })
    expect(sql).toContain('AS "votes.chamber"')
    expect(sql).toContain('AS "votes.label"')
    expect(sql).toContain('GROUP BY 1, 2 ')
    const mixed = compile({ groupBy: ['status', 'votes.label'], aggregate: { n: 'count' } }).sql
    expect(mixed).toContain(`NULLIF(to_jsonb(t."p_status"), 'null'::jsonb) AS "status"`)
    expect(mixed).toContain(`NULLIF(to_jsonb(c."p_label"), 'null'::jsonb) AS "votes.label"`)
  })

  it('rejects more than five keys and keys on different arrays', () => {
    expect(() => compile({ groupBy: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow(/at most 5 keys/)
    expect(() => compileQuery(collection, { groupBy: ['votes.label', 'items.sku'] }, { arrayPaths: ['items'] })).toThrow(/one nested array/)
  })
})

describe('compileQuery: projected nested object paths', () => {
  const nested: StorageRegistry = {
    ...registry,
    projections: [
      ...registry.projections,
      { field: 'totals.veterans.points', path: ['totals', 'veterans', 'points'], column: 'p_totals_veterans_points', type: 'number', reason: 'r' },
      { field: 'owner.name', path: ['owner', 'name'], column: 'p_owner_name', type: 'text', reason: 'r' },
      { field: 'owner.joined', path: ['owner', 'joined'], column: 'p_owner_joined', type: 'date', reason: 'r' },
      { field: 'owner.active', path: ['owner', 'active'], column: 'p_owner_active', type: 'boolean', reason: 'r' },
    ],
  }
  const run = (params: Parameters<typeof compileQuery>[1], reg: StorageRegistry = nested) => {
    const compiled = compileQuery({ id: 12, storage: reg }, params)
    const { sql, params: bound } = dialect.sqlToQuery(compiled.query)
    return { compiled, sql: sql.replace(/\s+/g, ' ').trim(), params: bound }
  }
  const withMixed = (field: string): StorageRegistry => ({
    ...nested,
    projections: nested.projections.map((p) => (p.field === field ? { ...p, mixed: true } : p)),
  })

  it('routes equality, ranges, $in, $nin and $ne on a projected path to its column', () => {
    const { sql, params, compiled } = run({ filter: { 'totals.veterans.points': { $gte: 10, $lt: 20, $ne: 15 }, 'owner.name': { $in: ['a', 'b'] }, 'owner.active': true } })
    expect(sql).toContain('t."p_totals_veterans_points" >= $1::float8')
    expect(sql).toContain('t."p_totals_veterans_points" < $2::float8')
    expect(sql).toContain('t."p_totals_veterans_points" IS DISTINCT FROM $3::float8')
    expect(sql).toContain('t."p_owner_name" IN ($4::text, $5::text)')
    expect(sql).toContain('t."p_owner_active" = $6::boolean')
    expect(params.slice(0, 3)).toEqual([10, 20, 15])
    expect(sql).not.toContain('#>')
    expect(compiled.clauses.map((c) => c.indexes[0])).toEqual([
      'hc_12_p_totals_veterans_points_idx', 'hc_12_p_totals_veterans_points_idx', 'hc_12_p_totals_veterans_points_idx',
      'hc_12_p_owner_name_idx', 'hc_12_p_owner_active_idx',
    ])
  })

  it('falls back to the document for literals of another type, $contains, mixed $exists and boolean ranges', () => {
    const { sql, params } = run({ filter: { 'totals.veterans.points': '7', 'owner.name': { $contains: 'x' } } })
    expect(sql).toContain('(t.data @> $1::jsonb OR t.data @> $2::jsonb)')
    expect(params[0]).toBe('{"totals":{"veterans":{"points":"7"}}}')
    expect(sql).toContain('ILIKE')
    expect(sql).not.toContain('p_totals_veterans_points')
    expect(sql).not.toContain('p_owner_name')
    // $exists uses the column only while every stored value fits it.
    expect(run({ filter: { 'owner.name': { $exists: true } } }).sql).toContain('t."p_owner_name" IS NOT NULL')
    expect(run({ filter: { 'owner.name': { $exists: true } } }, withMixed('owner.name')).sql).toContain('t.data #> $1::text[] IS NOT NULL')
    // The document route rejects a boolean range; the column must not accept it either.
    expect(() => run({ filter: { 'owner.active': { $gt: true } } })).toThrow(/requires a number or string operand/)
  })

  it('uses a date column for ranges only while no other value type is stored, and never for impossible dates', () => {
    expect(run({ filter: { 'owner.joined': { $gte: '2026-01-01' } } }).sql).toContain('t."p_owner_joined" >= $1::date')
    const mixed = run({ filter: { 'owner.joined': { $gte: '2026-01-01' } } }, withMixed('owner.joined')).sql
    expect(mixed).not.toContain('p_owner_joined')
    expect(mixed).toContain("jsonb_typeof(t.data #> $1::text[]) = 'string'")
    // Equality stays exact on a mixed date column.
    expect(run({ filter: { 'owner.joined': '2026-01-01' } }, withMixed('owner.joined')).sql).toContain('t."p_owner_joined" = $1::date')
    expect(run({ filter: { 'owner.joined': '2026-02-30' } }).sql).not.toContain('p_owner_joined')
  })

  it('sorts on the column, or on the document once the path holds mixed types', () => {
    const { sql, compiled } = run({ sort: '-totals.veterans.points' })
    expect(sql).toContain('AND t."p_totals_veterans_points" IS NOT NULL ORDER BY t."p_totals_veterans_points" DESC, t.id ASC LIMIT')
    expect(compiled.clauses).toEqual([{ label: 'sort on totals.veterans.points', indexes: ['hc_12_p_totals_veterans_points_idx'] }])
    const m = run({ sort: '-totals.veterans.points' }, withMixed('totals.veterans.points'))
    expect(m.sql).toContain('ORDER BY t.data #> $1::text[] DESC NULLS LAST')
    expect(m.compiled.clauses[0].note).toMatch(/more than one type/)
    const top = run({ sort: 'price' }, withMixed('price'))
    expect(top.sql).toContain('ORDER BY t.data->$1::text ASC NULLS LAST')
  })

  it('splits a descending projected sort into rows with a value, then rows without one', () => {
    const { compiled } = run({ sort: '-totals.veterans.points', limit: 5, offset: 10 })
    if (compiled.kind !== 'records') throw new Error('expected records')
    expect(compiled.nullsLast).toBeDefined()
    const nulls = dialect.sqlToQuery(compiled.nullsLast!.nullRows(3, 2))
    expect(nulls.sql).toContain('AND t."p_totals_veterans_points" IS NULL ORDER BY t.id ASC LIMIT')
    expect(nulls.params.slice(-2)).toEqual([3, 2])
    expect(dialect.sqlToQuery(compiled.nullsLast!.countWithValue).sql).toContain('count(*)::int AS count')
    // Ascending, mixed and document sorts keep a single query.
    for (const q of [run({ sort: 'totals.veterans.points' }), run({ sort: '-totals.veterans.points' }, withMixed('totals.veterans.points')), run({ sort: '-id' })]) {
      if (q.compiled.kind !== 'records') throw new Error('expected records')
      expect(q.compiled.nullsLast).toBeUndefined()
    }
  })

  it('aggregates numbers from the column exactly and groups by the typed key', () => {
    const { sql } = run({ groupBy: 'owner.name', aggregate: { pts: { sum: 'totals.veterans.points' }, hi: { max: 'totals.veterans.points' } } })
    expect(sql).toContain('to_jsonb(sum(t."p_totals_veterans_points"::text::numeric)) AS "pts"')
    expect(sql).toContain('coalesce(to_jsonb(max(t."p_totals_veterans_points"::text::numeric)), to_jsonb(bool_or(')
    expect(sql).toContain(`NULLIF(to_jsonb(t."p_owner_name"), 'null'::jsonb) AS "owner.name"`)
    // A mixed projection groups by the document value instead.
    expect(run({ groupBy: 'owner.name', aggregate: { n: 'count' } }, withMixed('owner.name')).sql).toContain(`NULLIF(t.data #> $1::text[], 'null'::jsonb) AS "owner.name"`)
  })

  it('explains an unprojected nested path in the clause note', () => {
    const { compiled } = run({ filter: { 'totals.other.points': { $gt: 1 } }, sort: 'totals.other.votes' })
    expect(compiled.clauses).toEqual([
      { label: 'filter on totals.other.points ($gt)', indexes: [], note: expect.stringMatching(/'totals.other.points' is a nested object path with no projection/) },
      { label: 'sort on totals.other.votes', indexes: [], note: expect.stringMatching(/'totals.other.votes' is a nested object path with no projection/) },
    ])
    const report = summarizePlan({ 'Node Type': 'Seq Scan', 'Relation Name': 'hc_12' }, 'hc_12', compiled.clauses)
    expect(report.reason).toMatch(/no projection/)
  })

  it('treats a key that is not a valid dotted path as a literal top-level key', () => {
    const { sql, params } = run({ filter: { 'a b.c': 1, 'x..y': 2 } })
    expect(sql).toContain('(t.data @> $1::jsonb OR t.data @> $2::jsonb)')
    expect(params.slice(0, 4)).toEqual(['{"a b.c":1}', '{"a b.c":[1]}', '{"x..y":2}', '{"x..y":[2]}'])
  })
})

describe('compileQuery: arrays of scalars in filters', () => {
  it('equality matches the value or an array holding it, both through the GIN', () => {
    const { sql, params, compiled } = compile({ filter: { tags: 'hiking' } })
    expect(sql).toContain('(t.data @> $1::jsonb OR t.data @> $2::jsonb)')
    expect(params.slice(0, 2)).toEqual(['{"tags":"hiking"}', '{"tags":["hiking"]}'])
    expect(compiled.clauses).toEqual([{ label: 'filter on tags', indexes: ['hc_12_data_gin_idx'] }])
  })

  it('an array value keeps containment: every listed element must be present', () => {
    const { sql, params } = compile({ filter: { tags: ['hiking', 'snow'] } })
    expect(sql).toContain('t.data @> $1::jsonb')
    expect(sql).not.toContain(' OR ')
    expect(params[0]).toBe('{"tags":["hiking","snow"]}')
  })

  it('$in is one lax jsonpath predicate (scalar or any element), served by the GIN; $nin negates it', () => {
    const inList = compile({ filter: { tags: { $in: ['hiking', 'snow'] } } })
    expect(inList.sql).toContain('t.data @? $1::jsonpath')
    expect(inList.params[0]).toBe('$."tags" ? (@ == "hiking" || @ == "snow")')
    expect(inList.compiled.clauses[0].indexes).toEqual(['hc_12_data_gin_idx'])
    const nin = compile({ filter: { tags: { $nin: ['hiking'] } } })
    expect(nin.sql).toContain('NOT t.data @? $1::jsonpath')
    expect(nin.compiled.clauses[0].indexes).toEqual([])
  })

  it('$contains, comparisons and $ne look inside arrays too, and are never reported as indexed', () => {
    const c = compile({ filter: { tags: { $contains: 'hik' } } })
    expect(c.sql).toContain('jsonb_array_elements(t.data->$')
    expect(c.sql).toContain('ILIKE')
    expect(c.compiled.clauses[0].indexes).toEqual([])
    const gt = compile({ filter: { nums: { $gt: 3 } } })
    expect(gt.sql).toContain("jsonb_typeof(arr_el.v) = 'number' AND (arr_el.v #>> '{}')::numeric > $")
    const ne = compile({ filter: { tags: { $ne: 'x' } } })
    expect(ne.sql).toContain('NOT (t.data @> $1::jsonb OR t.data @> $2::jsonb)')
    expect(ne.compiled.clauses[0].indexes).toEqual([])
  })

  it('explains $contains with an array operand', () => {
    expect(() => compile({ filter: { tags: { $contains: ['hiking'] } } })).toThrow(/\$contains requires a string operand.*\$in/)
  })

  it('a mixed projection answers from the column plus the array elements it cannot hold', () => {
    const mixed: StorageRegistry = { ...registry, projections: registry.projections.map((p) => (p.field === 'price' ? { ...p, mixed: true } : p)) }
    const run = (filter: Record<string, unknown>) => {
      const c = compileQuery({ id: 12, storage: mixed }, { filter })
      return { sql: dialect.sqlToQuery(c.query).sql, clauses: c.clauses }
    }
    const eq = run({ price: 5 })
    expect(eq.sql).toContain('(t."p_price" = $1::float8 OR t.data @> $2::jsonb)')
    expect(eq.clauses[0].indexes).toEqual(['hc_12_p_price_idx', 'hc_12_data_gin_idx'])
    expect(run({ price: { $ne: 5 } }).sql).toContain('(t."p_price" IS DISTINCT FROM $1::float8 AND NOT (jsonb_typeof(t.data->$2::text) = \'array\'')
    expect(run({ price: { $in: [5, 6] } }).sql).toContain('(t."p_price" IN ($1::float8, $2::float8) OR (jsonb_typeof(')
    expect(run({ price: { $exists: true } }).sql).toContain('t.data ? $1::text')
    // Unmixed: the column alone is exact.
    expect(compile({ filter: { price: 5 } }).sql).not.toContain('@>')
  })

  it('the lateral route filters elements with the same semantics', () => {
    const c = compileQuery(collection, { filter: { 'items.sku': 'a' }, groupBy: 'items.sku' }, { arrayPaths: ['items'] })
    expect(dialect.sqlToQuery(c.query).sql).toContain('(e.val @> $')
  })
})

describe('sortKeys and multi-key sort', () => {
  it('splits a comma list or an array, at most three keys', () => {
    expect(sortKeys('-points, name')).toEqual(['-points', 'name'])
    expect(sortKeys(['-points', 'name'])).toEqual(['-points', 'name'])
    expect(sortKeys(undefined)).toEqual([])
    expect(sortKeys('')).toEqual([])
    expect(() => sortKeys('a,b,c,d')).toThrow(/at most 3 keys/)
    expect(() => sortKeys('a,,b')).toThrow(/Invalid sort field ''/)
  })

  it('orders records by each key in turn, then the row id', () => {
    const { sql, compiled } = compile({ sort: '-price,status' })
    expect(sql).toContain('ORDER BY t."p_price" DESC NULLS LAST, t."p_status" ASC NULLS LAST, t.id ASC LIMIT')
    expect(compiled.clauses.map((c) => c.label)).toEqual(['sort on price', 'sort on status'])
    if (compiled.kind !== 'records') throw new Error('expected records')
    expect(compiled.nullsLast).toBeUndefined()
  })

  it('orders aggregate rows by several aliases and keys', () => {
    const { sql } = compile({ groupBy: ['status', 'day'], aggregate: { n: 'count', s: { sum: 'price' } }, sort: ['-n', '-s', 'day'] })
    expect(sql).toMatch(/ORDER BY 3 DESC NULLS LAST, 4 DESC NULLS LAST, 2 ASC NULLS LAST, 1 ASC LIMIT/)
    expect(() => compile({ groupBy: 'status', aggregate: { n: 'count' }, sort: '-n,nope' })).toThrow(/Invalid sort field 'nope' for an aggregate query/)
  })
})

describe('compileQuery: aggregates over booleans and arrays of scalars', () => {
  it('sums booleans as 1/0 and takes min/max of booleans as booleans', () => {
    const { sql } = compile({ aggregate: { yes: { sum: 'active' }, share: { avg: 'flag' }, lo: { min: 'flag' } } })
    // active is an unmixed boolean projection: its column, as an integer.
    expect(sql).toContain('to_jsonb(sum(t."p_active"::int::numeric)) AS "yes"')
    expect(sql).toContain("WHEN 'boolean' THEN CASE WHEN (t.data->$")
    expect(sql).toContain('to_jsonb(bool_and(CASE WHEN jsonb_typeof(t.data->$')
    // Untyped fields carry a hidden type check; typed columns do not.
    expect(sql).toContain('AS "__type_0"')
    expect(sql).not.toContain('"__type_1"')
  })

  it('groups a key that holds arrays per element (lateral unnest), keeping the JSON type', () => {
    const c = compileQuery(collection, { groupBy: 'tags', aggregate: { n: 'count', s: { sum: 'price' } } }, { scalarArrayKeys: ['tags'] })
    const sql = dialect.sqlToQuery(c.query).sql
    expect(sql).toContain('FROM "hc_12" t, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.data->$')
    expect(sql).toContain(`AS g0(val)`)
    expect(sql).toContain(`NULLIF(g0.val, 'null'::jsonb) AS "tags"`)
  })
})

describe('typeCheckWarnings', () => {
  const checks = [{ alias: 's', op: 'sum', field: 'name', column: '__type_0' }]
  it('fails when every group met only unsupported types, naming them', () => {
    expect(() => typeCheckWarnings(checks, [{ s: null, __type_0: 'string' }])).toThrow(/sum 's' over 'name' found string values.*booleans count as 1/)
  })
  it('warns when only some groups did, and is silent otherwise', () => {
    expect(typeCheckWarnings(checks, [{ s: null, __type_0: 'string' }, { s: 3, __type_0: 'string' }])).toEqual([
      "sum 's' over 'name' is null in 1 of 2 groups, whose values are string: sum and avg take numbers and booleans only.",
    ])
    expect(typeCheckWarnings(checks, [{ s: null, __type_0: null }])).toEqual([])
  })
})

describe('summarizePlan: plan text agrees with indexed', () => {
  it('names an index that serves none of the clauses as such', () => {
    const report = summarizePlan(
      { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'hc_12_created_at_idx', 'Relation Name': 'hc_12' }] },
      'hc_12',
      [{ label: 'filter on asker.user_id', indexes: ['hc_12_data_gin_idx'], note: "'asker.user_id' is a nested object path with no projection" }],
    )
    expect(report.indexed).toBe(false)
    expect(report.plan).toBe("Index Scan using hc_12_created_at_idx on hc_12, serving none of the query's clauses")
    expect(report.reason).toMatch(/hc_12_created_at_idx only supplied row order or the live-row check/)
    expect(report.reason!.match(/evaluated over the stored documents/g)).toHaveLength(1)
  })
})

describe('filter operator validation', () => {
  it('rejects malformed operands before any SQL runs', () => {
    expect(() => compile({ filter: { f: { $gt: true } } })).toThrow(/\$gt requires a number or string operand/)
    expect(() => compile({ filter: { f: { $lte: null } } })).toThrow(/\$lte requires a number or string operand/)
    expect(() => compile({ filter: { f: { $in: 'active' } } })).toThrow(/\$in requires an array operand/)
    expect(() => compile({ filter: { f: { $exists: 'yes' } } })).toThrow(/\$exists requires a boolean operand/)
    expect(() => compile({ filter: { f: { $regex: 'a' } } })).toThrow(/Unsupported filter operator '\$regex'/)
  })

  it('caps $in/$nin lists at 1000 elements', () => {
    const big = Array.from({ length: 1001 }, (_, i) => i)
    expect(() => compile({ filter: { f: { $in: big } } })).toThrow(/limited to 1000 elements/)
    expect(() => compile({ filter: { f: { $nin: big } } })).toThrow(/limited to 1000 elements/)
    expect(() => compile({ filter: { f: { $in: big.slice(0, 1000) } } })).not.toThrow()
  })

  it('throws ClientInputError so the MCP chokepoint treats caller mistakes as expected, not bugs', () => {
    expect(() => compile({ filter: { f: { $regex: 'a' } } })).toThrow(ClientInputError)
    expect(() => compile({ filter: { f: { $in: 'active' } } })).toThrow(ClientInputError)
    expect(() => compile({ aggregate: { m: { median: 'price' } } })).toThrow(ClientInputError)
    expect(() => compile({ sort: 'bad field!' })).toThrow(ClientInputError)
  })

  it('compiles empty $in to false and empty $nin to true', () => {
    expect(compile({ filter: { f: { $in: [] } } }).sql).toContain('false')
    expect(compile({ filter: { f: { $nin: [] } } }).sql).toContain('true')
  })
})

describe('compileQuery: $or / $and', () => {
  it('joins branches with OR, each branch self-contained, and keeps branch clauses for indexed reporting', () => {
    const { sql, compiled } = compile({ filter: { $or: [{ price: 10 }, { status: 'open', 'votes.points': { $gt: 3 } }] } })
    expect(sql).toContain('((t."p_price" = $1::float8) OR (t."p_status" = $2::text AND EXISTS (SELECT 1 FROM "hc_12__votes" c WHERE c.parent_id = t.id AND c."p_points" > $3::float8)))')
    expect(compiled.clauses.map((c) => c.label)).toEqual(['filter on price', 'filter on status', 'filter on votes.points'])
  })

  it('nests $and inside $or alongside plain keys', () => {
    const { sql } = compile({ filter: { active: true, $or: [{ $and: [{ price: { $gte: 1 } }, { price: { $lt: 5 } }] }, { status: 'x' }] } })
    expect(sql).toContain('t."p_active" = $1::boolean AND ((((t."p_price" >= $2::float8) AND (t."p_price" < $3::float8))) OR (t."p_status" = $4::text))')
  })

  it('keeps conditions on one array inside a branch on the same element', () => {
    const { sql } = compile({ filter: { $or: [{ 'votes.x.y': 1, 'votes.z': 2 }, { price: 1 }] } })
    expect(sql).toMatch(/OR/)
    expect(sql).toContain('@? $')
  })

  it('rejects other top-level $ keys and malformed branches', () => {
    expect(() => compile({ filter: { $nor: [{ price: 1 }] } })).toThrow(/Unsupported top-level filter operator '\$nor'. Supported: \$and, \$or/)
    expect(() => compile({ filter: { $gt: 1 } })).toThrow(/Unsupported top-level filter operator '\$gt'/)
    expect(() => compile({ filter: { $or: [] } })).toThrow(/non-empty array of filters/)
    expect(() => compile({ filter: { $or: { price: 1 } } })).toThrow(/non-empty array of filters/)
    expect(() => compile({ filter: { $and: [1] } })).toThrow(/non-empty array of filters/)
  })
})

describe('compileQuery: count of a path, first, group_by keys', () => {
  it('"count" counts rows; {"count": path} counts rows with a non-null value there; {"count": "*"} is count', () => {
    const { sql } = compile({ groupBy: 'status', aggregate: { rows: 'count', star: { count: '*' }, titled: { count: 'title' }, priced: { count: 'price' } } })
    expect(sql).toContain('count(*)::int AS "rows"')
    expect(sql).toContain('count(*)::int AS "star"')
    expect(sql).toMatch(/\(count\(\*\) FILTER \(WHERE t\.data->\$\d+::text IS NOT NULL AND t\.data->\$\d+::text <> 'null'::jsonb\)\)::int AS "titled"/)
    // A projected field without misfits is read from its column, like a group key.
    expect(sql).toContain(`(count(*) FILTER (WHERE to_jsonb(t."p_price") IS NOT NULL AND to_jsonb(t."p_price") <> 'null'::jsonb))::int AS "priced"`)
  })

  it('{"count": path} and first on an unwound array read the element itself (lateral), not the child column', () => {
    const counted = compile({ groupBy: 'status', aggregate: { n: { count: 'votes.points' } } }).sql
    expect(counted).toContain('jsonb_array_elements(')
    expect(counted).not.toContain('"hc_12__votes" c JOIN')
    const summed = compile({ groupBy: 'status', aggregate: { n: { sum: 'votes.points' } } }).sql
    expect(summed).toContain('"hc_12__votes" c JOIN')
  })

  it('first takes the first non-null value in row id (then element) order', () => {
    expect(compile({ groupBy: 'status', aggregate: { p: { first: 'title' } } }).sql).toMatch(/\(array_agg\(t\.data->\$\d+::text ORDER BY t\.id\) FILTER \(WHERE .* <> 'null'::jsonb\)\)\[1\] AS "p"/)
    expect(compile({ groupBy: 'status', aggregate: { p: { first: 'price' } } }).sql).toContain(`(array_agg(to_jsonb(t."p_price") ORDER BY t.id)`)
    expect(compile({ groupBy: 'votes.label', aggregate: { p: { first: 'votes.points' } } }).sql).toContain('ORDER BY t.id, e.ord)')
  })

  it('rejects specs with no op, several ops, or a non-string field', () => {
    expect(() => compile({ aggregate: { x: { sum: 'price', max: 'price' } } })).toThrow(/one \{op: field\}.*e\.g\. \{"rows": "count"/)
    expect(() => compile({ aggregate: { x: 'total' } })).toThrow(/Unsupported aggregation 'total' for 'x'/)
    expect(() => compile({ aggregate: { x: { sum: 3 } } as never })).toThrow(/takes a field name/)
  })

  it('takes up to 5 group_by keys', () => {
    expect(compile({ groupBy: ['a', 'b', 'c', 'd', 'e'] }).sql).toContain('GROUP BY 1, 2, 3, 4, 5')
    expect(() => compile({ groupBy: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow(/at most 5 keys/)
  })
})

describe('compileQuery: limit 0 counts', () => {
  it('a records query with limit 0 compiles to the count only, with the filter clauses but not the sort', () => {
    const compiled = compileQuery(collection, { filter: { price: 10 }, sort: '-status', limit: 0 })
    expect(compiled.kind).toBe('records')
    if (compiled.kind !== 'records') return
    expect(compiled.countOnly).toBe(true)
    expect(compiled.limit).toBe(0)
    expect(dialect.sqlToQuery(compiled.query).sql).toMatch(/^SELECT count\(\*\)::int AS count FROM "hc_12" t WHERE .*"p_price" = \$1::float8$/)
    expect(compiled.clauses.map((c) => c.label)).toEqual(['filter on price'])
  })

  it('an aggregate with limit 0 still reads one row for the group total and reports limit 0', () => {
    const compiled = compileQuery(collection, { groupBy: 'status', limit: 0 })
    expect(compiled.limit).toBe(0)
    expect(dialect.sqlToQuery(compiled.query).params.slice(-2)).toEqual([1, 0])
  })

  it('a negative limit is an error', () => {
    expect(() => compileQuery(collection, { limit: -1 })).toThrow(/0 or more/)
  })
})

describe('indexed reason wording', () => {
  it('names clauses an index could have served apart from those none can serve', () => {
    const plan = { 'Node Type': 'Seq Scan', 'Relation Name': 'hc_12' }
    const report = summarizePlan(plan, 'hc_12', [
      { label: 'filter on price', indexes: ['hc_12_p_price_idx'] },
      { label: 'filter on title ($contains)', indexes: [] },
    ])
    expect(report.reason).toBe('No index served filter on price; no index can serve filter on title ($contains); the clauses were evaluated over the stored documents.')
  })

  it('an aggregate sort is not a clause, so the reason never suggests an index for it', () => {
    const compiled = compileQuery(collection, { groupBy: 'status', aggregate: { n: 'count' }, sort: '-n' })
    expect(compiled.clauses).toEqual([])
    const report = summarizePlan({ 'Node Type': 'Seq Scan', 'Relation Name': 'hc_12' }, 'hc_12', compiled.clauses)
    expect(report.reason).not.toMatch(/sort on/)
  })
})

describe('compileQuery: $size, expressions and time_bucket on a data field', () => {
  it('compiles $size to a bound comparison on element/key count, and never routes it to a column', () => {
    const { sql, params } = compile({ filter: { price: { $size: { $gt: 3 } }, tags: { $size: 2 } } })
    expect(sql).toContain("jsonb_array_length")
    expect(sql).toContain("jsonb_object_keys")
    expect(sql).not.toContain('t."p_price" >')
    expect(params).toEqual(expect.arrayContaining([3, 2]))
    expect(() => compile({ filter: { 'votes.label': { $size: 1 } } })).toThrow(/array of objects/)
    expect(() => compile({ filter: { tags: { $size: { $gt: '1' } } } })).toThrow(/\$size \$gt takes a number/)
  })

  it('runs an expression over unwound number columns on the child table, and binds every path and literal', () => {
    const { sql, params } = compile({ groupBy: 'votes.label', aggregate: { r: { sum: { $multiply: ['votes.points', 'votes.category_id', 2] } } } })
    expect(sql).toContain('FROM "hc_12__votes" c JOIN "hc_12" t ON t.id = c.parent_id')
    expect(sql).toContain('to_jsonb(sum(((c."p_points"::text::numeric) * (c."p_category_id"::text::numeric) * $')
    expect(params).toContain(2)
    expect(sql).not.toContain('votes.points')
  })

  it('unnests the array for an operand no number column holds ($size, a text column, a deeper path)', () => {
    for (const expr of [{ $size: 'votes.tags' }, { $add: ['votes.label', 1] }, { $add: ['votes.points.veterans', 1] }]) {
      const { sql } = compile({ aggregate: { x: { max: expr } }, groupBy: 'votes.category_id' })
      expect(sql, JSON.stringify(expr)).toContain('jsonb_array_elements')
      expect(sql).not.toContain('"hc_12__votes" c JOIN')
    }
  })

  it('divides through NULLIF so a zero divisor is null, not an error', () => {
    expect(compile({ aggregate: { x: { avg: { $divide: ['price', 'price'] } } } }).sql).toContain('NULLIF(')
  })

  it('buckets a data field in UTC with a validity guard, from an unmixed projection column', () => {
    const { sql, params } = compile({ timeBucket: { field: 'day', unit: 'month' }, aggregate: { n: 'count' } })
    expect(sql).toContain("pg_input_is_valid(")
    expect(sql).toContain("AT TIME ZONE 'UTC'")
    expect(sql).toContain("date_trunc('month'")
    expect(sql).toContain('to_jsonb(t."p_day")')
    expect(sql).not.toContain('t.created_at)')
    expect(params.some((p) => typeof p === 'string' && p.startsWith('^\\d{4}'))).toBe(true)
  })

  it('keeps the string form on created_at and rejects a malformed object form', () => {
    expect(compile({ timeBucket: 'week', aggregate: { n: 'count' } }).sql).toContain("date_trunc('week', t.created_at) AS time_bucket")
    expect(() => compile({ timeBucket: { field: 'day', unit: 'decade' }, aggregate: { n: 'count' } })).toThrow(/Invalid time_bucket unit 'decade'/)
    expect(() => compile({ timeBucket: { field: 'a b', unit: 'day' }, aggregate: { n: 'count' } })).toThrow(/Invalid field name/)
  })
})

describe('compileQuery: result column names never collide', () => {
  it('rejects an aggregate alias that is also a group_by key', () => {
    expect(() => compileQuery(collection, { groupBy: 'plan', aggregate: { plan: 'count' } })).toThrow(/'plan' is both a group_by key and an aggregate alias/)
  })

  it('rejects grouping by a field named count without an aggregate (the default count column)', () => {
    expect(() => compileQuery(collection, { groupBy: 'count' })).toThrow(/group_by key 'count' collides with the default count column.*aggregate/)
    expect(() => compileQuery(collection, { groupBy: 'count', aggregate: { n: 'count' } })).not.toThrow()
  })

  it('rejects names the response adds to each row: time_bucket, parent_id and record', () => {
    expect(() => compileQuery(collection, { groupBy: 'time_bucket', timeBucket: 'day' })).toThrow(/'time_bucket'.*reserved/)
    expect(() => compileQuery(collection, { groupBy: 'status', aggregate: { time_bucket: 'count' }, timeBucket: 'day' })).toThrow(/'time_bucket'.*reserved/)
    expect(() => compileQuery(collection, { groupBy: 'items.sku', aggregate: { record: 'count' }, perRecord: true }, { arrayPaths: ['items'] })).toThrow(/'record'.*reserved/)
    expect(() => compileQuery(collection, { groupBy: ['parent_id', 'items.sku'], perRecord: true }, { arrayPaths: ['items'] })).toThrow(/'parent_id'.*reserved/)
    // Without per_record / time_bucket those names are ordinary fields.
    expect(() => compileQuery(collection, { groupBy: 'record', aggregate: { parent_id: 'count' } })).not.toThrow()
  })

  it('rejects aliases starting with __ (internal columns)', () => {
    expect(() => compileQuery(collection, { groupBy: 'status', aggregate: { __total: 'count' } })).toThrow(/'__total'.*reserved/)
  })

  it('allows group keys named like response fields (plan, total, indexed): they live inside each results object', () => {
    expect(() => compileQuery(collection, { groupBy: ['plan', 'total', 'indexed'], aggregate: { n: 'count' } })).not.toThrow()
  })
})
