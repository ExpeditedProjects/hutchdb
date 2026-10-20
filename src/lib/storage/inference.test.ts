import { describe, it, expect } from 'vitest'
import {
  arrayCandidates,
  declareFields,
  declareNestedFields,
  inferDecisions,
  surveyArrays,
  thresholdsFromEnv,
  MAX_PROJECTED_TEXT,
  MAX_PROJECTIONS,
  MAX_UNWINDS,
  MAX_ARRAY_COUNTS_PER_BATCH,
  pathsToCount,
  type InferenceInput,
} from './inference'
import {
  EMPTY_REGISTRY,
  PG_MAX_IDENTIFIER,
  childTableName,
  findPathProjection,
  findProjection,
  indexName,
  sanitizeIdentifier,
  uniqueColumnName,
  ident,
  type StorageRegistry,
} from './registry'

function docs(n: number, make: (i: number) => Record<string, unknown>): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => make(i))
}

const thresholds = { project: 100, unwind: 100 }

function input(overrides: Partial<InferenceInput>): InferenceInput {
  return {
    collectionId: 7,
    docs: [],
    registry: EMPTY_REGISTRY,
    rowCount: 0,
    elementCounts: {},
    thresholds,
    ...overrides,
  }
}

describe('sanitizeIdentifier', () => {
  it('lowercases and replaces anything outside [a-z0-9_]', () => {
    expect(sanitizeIdentifier('Category ID')).toBe('category_id')
    expect(sanitizeIdentifier('price-usd')).toBe('price_usd')
    expect(sanitizeIdentifier('a.b.c')).toBe('a_b_c')
  })

  it('never yields an empty name or one starting with a digit', () => {
    expect(sanitizeIdentifier('')).toBe('f')
    expect(sanitizeIdentifier('!!!')).toBe('f')
    expect(sanitizeIdentifier('2024')).toBe('f_2024')
  })

  it('neutralizes SQL metacharacters', () => {
    expect(sanitizeIdentifier(`x"; DROP TABLE records; --`)).toBe('x_drop_table_records')
  })

  it('keeps long names under the limit and distinct', () => {
    const a = sanitizeIdentifier('a'.repeat(100) + '1')
    const b = sanitizeIdentifier('a'.repeat(100) + '2')
    expect(a.length).toBeLessThanOrEqual(40)
    expect(a).not.toBe(b)
  })

  it('column names for colliding fields stay unique', () => {
    const first = uniqueColumnName('a-b', [])
    const second = uniqueColumnName('a_b', [first])
    expect(first).toBe('p_a_b')
    expect(second).not.toBe(first)
    expect(second.startsWith('p_a_b_')).toBe(true)
  })

  it('index and table names respect the 63-char Postgres limit', () => {
    const table = childTableName(123456, 'x'.repeat(60))
    expect(table.length).toBeLessThanOrEqual(63)
    const idx = indexName(table, `p_${'y'.repeat(38)}`)
    expect(idx.length).toBeLessThanOrEqual(63)
    expect(idx.endsWith('_idx')).toBe(true)
  })

  it('ident() refuses anything the sanitizer could not have produced', () => {
    expect(() => ident('p_ok')).not.toThrow()
    expect(() => ident('P_Upper')).toThrow(/Unsafe/)
    expect(() => ident('a"b')).toThrow(/Unsafe/)
    expect(() => ident('x'.repeat(64))).toThrow(/Unsafe/)
  })
})

describe('thresholdsFromEnv', () => {
  it('defaults to 10,000 and honors the env overrides', () => {
    expect(thresholdsFromEnv({})).toEqual({ project: 10_000, unwind: 10_000 })
    expect(thresholdsFromEnv({ HUTCH_PROJECT_THRESHOLD: '50', HUTCH_UNWIND_THRESHOLD: '0' })).toEqual({ project: 50, unwind: 0 })
    expect(thresholdsFromEnv({ HUTCH_PROJECT_THRESHOLD: 'nope' }).project).toBe(10_000)
  })
})

describe('declareFields', () => {
  it('declares scalar keys present in >= 90% with one type in >= 95%', () => {
    const batch = docs(100, (i) => ({
      n: i,
      s: `v${i}`,
      b: i % 2 === 0,
      rare: i < 50 ? 1 : undefined, // 50% presence — not declared
      mixed: i % 2 === 0 ? 1 : 'x', // 50/50 types — not declared
      obj: { nested: true }, // not scalar
    }))
    const declared = declareFields(batch)
    expect(declared.map((d) => [d.field, d.type])).toEqual([
      ['b', 'boolean'],
      ['n', 'number'],
      ['s', 'text'],
    ])
  })

  it('tolerates up to 5% type outliers and 10% missing keys', () => {
    const batch = docs(100, (i) => ({
      ...(i < 91 ? { n: i < 87 ? i : 'oops' } : {}), // 91% present, 4/91 strings
    }))
    expect(declareFields(batch)).toEqual([{ field: 'n', type: 'number', presence: 0.91 }])
  })

  it('treats null as absent', () => {
    const batch = docs(10, (i) => ({ n: i < 5 ? null : i }))
    expect(declareFields(batch)).toEqual([])
  })

  it('declares strict YYYY-MM-DD strings as date, anything else as text', () => {
    expect(declareFields(docs(10, (i) => ({ d: `2026-01-${String(i + 1).padStart(2, "0")}` })))[0].type).toBe('date')
    expect(declareFields(docs(10, (i) => ({ d: `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00Z` })))[0].type).toBe('text')
  })

  it('declares a date only when every text value is a real calendar date', () => {
    // "2024-02-30" is YYYY-MM-DD but no date: the date column would hold
    // NULL for it and the new projection would start out mixed.
    const batch = docs(100, (i) => ({ d: i === 7 ? '2024-02-30' : `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, nested: { d: i === 7 ? '2024-02-30' : '2024-01-01' } }))
    expect(declareFields(batch).find((f) => f.field === 'd')?.type).toBe('text')
    expect(declareNestedFields(batch).find((f) => f.field === 'nested.d')?.type).toBe('text')
    const valid = docs(100, (i) => ({ d: `2024-02-${String((i % 29) + 1).padStart(2, '0')}` }))
    expect(declareFields(valid)[0].type).toBe('date')
  })
})

describe('arrayCandidates', () => {
  it('finds top-level arrays of objects and declares their element keys', () => {
    const batch = docs(20, (i) => ({
      id: i,
      votes: [{ category_id: 1, points: i }, { category_id: 2, points: 2 * i }],
      tags: ['a', 'b'], // array of strings: not a candidate
      misc: i % 2 ? [{ k: 1 }] : 'no', // only 50%: not a candidate
    }))
    const candidates = arrayCandidates(batch)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].path).toBe('votes')
    expect(candidates[0].batchElements).toBe(40)
    expect(candidates[0].fields.map((f) => [f.field, f.type])).toEqual([
      ['category_id', 'number'],
      ['points', 'number'],
    ])
  })

  it('ignores arrays whose elements have no declarable key', () => {
    const batch = docs(10, (i) => ({ items: [{ [`k${i}`]: i }] }))
    expect(arrayCandidates(batch)).toEqual([])
  })
})

describe('inferDecisions', () => {
  const batch = docs(50, (i) => ({ id: i, name: `n${i}`, votes: [{ category_id: i % 3, points: i }] }))

  it('projects nothing below the row threshold and without an unwind', () => {
    const d = inferDecisions(input({ docs: batch, rowCount: 99, elementCounts: { votes: 50 } }))
    expect(d.projections).toEqual([])
    expect(d.unwinds).toEqual([])
  })

  it('projects declared scalars once the collection reaches the threshold', () => {
    const d = inferDecisions(input({ docs: batch, rowCount: 100 }))
    expect(d.projections.map((p) => [p.field, p.column, p.type])).toEqual([
      ['id', 'p_id', 'number'],
      ['name', 'p_name', 'text'],
    ])
    expect(d.projections[0].reason).toMatch(/reached 100 rows/)
    expect(d.unwinds).toEqual([])
  })

  it('unwinds an array at the element threshold and projects the parent keys regardless of row count', () => {
    const d = inferDecisions(input({ docs: batch, rowCount: 50, elementCounts: { votes: 100 } }))
    expect(d.unwinds).toHaveLength(1)
    const [u] = d.unwinds
    expect(u.path).toBe('votes')
    expect(u.table).toBe('hc_7__votes')
    expect(u.fields).toEqual([
      { field: 'category_id', column: 'p_category_id', type: 'number' },
      { field: 'points', column: 'p_points', type: 'number' },
    ])
    expect(u.reason).toMatch(/100 elements/)
    expect(d.projections.map((p) => p.field)).toEqual(['id', 'name'])
    expect(d.projections[0].reason).toMatch(/group nested aggregates/)
  })

  it('does not unwind below the element threshold', () => {
    const d = inferDecisions(input({ docs: batch, rowCount: 50, elementCounts: { votes: 99 } }))
    expect(d.unwinds).toEqual([])
  })

  it('is idempotent: never recreates what the registry already has', () => {
    const registry: StorageRegistry = {
      projections: [{ field: 'id', column: 'p_id', type: 'number', reason: 'r' }],
      unwinds: [{ path: 'votes', table: 'hc_7__votes', fields: [], reason: 'r' }],
      evaluated_rows: 50,
    }
    const d = inferDecisions(input({ docs: batch, registry, rowCount: 100, elementCounts: { votes: 1000 } }))
    expect(d.unwinds).toEqual([])
    expect(d.projections.map((p) => p.field)).toEqual(['name'])
  })

  it('caps projections at 16 per collection, including existing ones', () => {
    const wide = docs(10, (i) => Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`f${k}`, i])))
    const d = inferDecisions(input({ docs: wide, rowCount: 1000 }))
    expect(d.projections).toHaveLength(MAX_PROJECTIONS)

    const registry: StorageRegistry = {
      projections: Array.from({ length: 15 }, (_, k) => ({ field: `z${k}`, column: `p_z${k}`, type: 'number' as const, reason: 'r' })),
      unwinds: [],
      evaluated_rows: 0,
    }
    expect(inferDecisions(input({ docs: wide, registry, rowCount: 1000 })).projections).toHaveLength(1)
  })

  it('gives colliding sanitized names distinct columns', () => {
    const batch2 = docs(10, (i) => ({ 'a-b': i, a_b: `s${i}` }))
    const d = inferDecisions(input({ docs: batch2, rowCount: 1000 }))
    const columns = d.projections.map((p) => p.column)
    expect(new Set(columns).size).toBe(2)
  })
})

describe('nested object paths', () => {
  const CATEGORIES = Array.from({ length: 24 }, (_, k) => `cat_${String(k).padStart(2, '0')}`)

  it('declares scalars two and three keys deep under the same presence and type rule', () => {
    const batch = docs(100, (i) => ({
      name: `n${i}`,
      owner: { id: i, display_name: `u${i}`, ...(i < 85 ? { location: 'x' } : {}) },
      stats: { score: { up: i, down: i % 3 }, flags: [1, 2], when: '2026-01-02' },
      deep: { a: { b: { c: 1 } } },
      ...(i % 2 ? { 'bad key': { x: 1 } } : {}),
    }))
    expect(declareNestedFields(batch).map((f) => [f.field, f.type, f.path])).toEqual([
      ['owner.display_name', 'text', ['owner', 'display_name']],
      ['owner.id', 'number', ['owner', 'id']],
      ['stats.when', 'date', ['stats', 'when']],
      ['stats.score.down', 'number', ['stats', 'score', 'down']],
      ['stats.score.up', 'number', ['stats', 'score', 'up']],
    ])
    // owner.location is in 85% (< 90%); arrays, a fourth key level and keys
    // the dotted-path syntax cannot address are never candidates.
  })

  it('tolerates type outliers and treats JSON null as absent, like top-level fields', () => {
    const batch = docs(100, (i) => ({ t: { v: i === 3 ? 'three' : i === 4 ? null : i } }))
    expect(declareNestedFields(batch)).toEqual([{ field: 't.v', path: ['t', 'v'], type: 'number', presence: 0.99 }])
  })

  it('skips every path under an object with more keys than the projection cap (a map)', () => {
    const batch = docs(50, (i) => ({
      totals: Object.fromEntries(CATEGORIES.map((c) => [c, { points: i, possible: i, votes: i }])),
      stats: Object.fromEntries(Array.from({ length: MAX_PROJECTIONS }, (_, k) => [`s${k}`, i])),
    }))
    const declared = declareNestedFields(batch)
    expect(declared.some((f) => f.field.startsWith('totals.'))).toBe(false)
    expect(declared.filter((f) => f.field.startsWith('stats.'))).toHaveLength(MAX_PROJECTIONS)
  })

  it('projects top-level fields first, then nested paths, within one cap', () => {
    const batch = docs(10, (i) => ({
      ...Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`f${String(k).padStart(2, '0')}`, i])),
      a: { x: i, y: i, z: { w: i } },
      b: { q: `s${i}`, r: i, s: i },
    }))
    const d = inferDecisions(input({ docs: batch, rowCount: 1000 }))
    expect(d.projections).toHaveLength(MAX_PROJECTIONS)
    expect(d.projections.slice(0, 12).every((p) => p.path === undefined)).toBe(true)
    // 4 slots left; equal presence, so shallower paths first, then by name.
    expect(d.projections.slice(12).map((p) => [p.field, p.column, p.path])).toEqual([
      ['a.x', 'p_a_x', ['a', 'x']],
      ['a.y', 'p_a_y', ['a', 'y']],
      ['b.q', 'p_b_q', ['b', 'q']],
      ['b.r', 'p_b_r', ['b', 'r']],
    ])
    expect(d.projections[12].reason).toMatch(/'a.x' is a number in 100% of documents and the collection reached 1000 rows/)
  })

  it('projects nested paths with the parent fields when an unwind is created', () => {
    const batch = docs(20, (i) => ({ name: `n${i}`, totals: { veterans: { points: i, votes: i } }, votes: [{ c: 1 }, { c: 2 }] }))
    const d = inferDecisions(input({ docs: batch, rowCount: 20, elementCounts: { votes: 100 } }))
    expect(d.unwinds).toHaveLength(1)
    expect(d.projections.map((p) => p.field)).toEqual(['name', 'totals.veterans.points', 'totals.veterans.votes'])
    expect(d.projections[1]).toMatchObject({ path: ['totals', 'veterans', 'points'], column: 'p_totals_veterans_points', type: 'number' })
    expect(d.projections[1].reason).toMatch(/when a nested array was made queryable/)
  })

  it('keeps a top-level key and a same-looking nested path apart', () => {
    const batch = docs(10, (i) => ({ a_b: i, a: { b: i }, 'a.b': i }))
    const d = inferDecisions(input({ docs: batch, rowCount: 1000 }))
    const byPath = (p: { path?: string[]; field: string }) => JSON.stringify(p.path ?? p.field)
    expect(d.projections.map(byPath).sort()).toEqual(['"a.b"', '"a_b"', '["a","b"]'])
    expect(new Set(d.projections.map((p) => p.column)).size).toBe(3)
    const registry: StorageRegistry = { projections: d.projections, unwinds: [], evaluated_rows: 0 }
    expect(findProjection(registry, 'a.b')?.path).toBeUndefined()
    expect(findPathProjection(registry, ['a', 'b'])?.path).toEqual(['a', 'b'])
    // Idempotent: a second batch adds nothing.
    expect(inferDecisions(input({ docs: batch, registry, rowCount: 2000 })).projections).toEqual([])
  })

  it('names long paths safely within 63 characters with a deterministic hash', () => {
    const long = 'segment_with_a_rather_long_name_'
    const batch = docs(10, (i) => ({ [long + 'one']: { [long + 'two']: { [long + 'three']: i } } }))
    const [p] = inferDecisions(input({ docs: batch, rowCount: 1000 })).projections
    expect(p.path).toHaveLength(3)
    expect(p.column.length).toBeLessThanOrEqual(PG_MAX_IDENTIFIER)
    expect(p.column).toMatch(/^p_[a-z0-9_]+_[0-9a-f]{8}$/)
    expect(() => ident(p.column)).not.toThrow()
    expect(indexName('hc_123456', p.column).length).toBeLessThanOrEqual(PG_MAX_IDENTIFIER)
    expect(inferDecisions(input({ docs: batch, rowCount: 1000 })).projections[0].column).toBe(p.column)
  })

  it('on dollarvote-shaped legislators, the per-category totals map is never projected', () => {
    const legislators = docs(555, (i) => ({
      bioguide_id: `B${i}`, icpsr: i, congress: 118, chamber: i % 5 ? 'House' : 'Senate', name: `N${i}`, party: i % 2 ? 'D' : 'R',
      state: 'CA', ...(i % 5 ? { district: i % 50 } : { district: null }), opensecrets_id: `N${i}`, fec_ids: [`F${i}`], govtrack_id: i,
      totals: Object.fromEntries(CATEGORIES.filter((_, k) => (i + k) % 40).map((c) => [c, { points: i % 30, possible: 29, votes: 24 }])),
      votes: [{ bill_id: 'HR1', vote: 'yea', points: { cat_00: 1 } }],
      scores: [{ category: 'cat_00', bill_id: 'HR1', points: 1, possible: 1 }],
    }))
    const d = inferDecisions(input({ docs: legislators, rowCount: 555, elementCounts: { votes: 177_677, scores: 297_309 } }))
    expect(d.unwinds.map((u) => u.path)).toEqual(['scores', 'votes'])
    expect(d.projections.map((p) => p.field).sort()).toEqual(['bioguide_id', 'chamber', 'congress', 'govtrack_id', 'icpsr', 'name', 'opensecrets_id', 'party', 'state'])
    expect(d.projections.some((p) => p.field.startsWith('totals.'))).toBe(false)
  })
})

describe('long text and pending unwinds', () => {
  const long = 'x'.repeat(300)

  it('never declares a text field holding a value over MAX_PROJECTED_TEXT characters', () => {
    const batch = docs(20, (i) => ({ title: `t${i}`, body: i === 3 ? long : 'short', meta: { note: i === 5 ? long : 'n' } }))
    expect(declareFields(batch).map((f) => f.field)).toEqual(['title'])
    expect(declareNestedFields(batch).map((f) => f.field)).toEqual([])
    expect(MAX_PROJECTED_TEXT).toBe(256)
  })

  it('leaves long text out of an unwind (the btree cannot index it) and still unwinds', () => {
    const batch = docs(50, (i) => ({ id: i, answers: [{ answer_id: i, score: i % 7, body: long }] }))
    const d = inferDecisions(input({ docs: batch, rowCount: 50, elementCounts: { answers: 150 } }))
    expect(d.unwinds.map((u) => u.path)).toEqual(['answers'])
    expect(d.unwinds[0].fields.map((f) => f.field)).toEqual(['answer_id', 'score'])
  })

  it('says why an array of objects is not unwound yet', () => {
    const below = docs(20, (i) => ({ votes: [{ k: i }] }))
    expect(inferDecisions(input({ docs: below, rowCount: 20, elementCounts: { votes: 40 } })).pending)
      .toEqual([{ path: 'votes', reason: "'votes' holds 40 elements across the collection; it is unwound at 100." }])

    const sparse = docs(20, (i) => (i < 5 ? { items: [{ k: i }] } : { other: i }))
    expect(surveyArrays(sparse).rejected[0].reason).toMatch(/array of objects in only 25% of the last batch's documents \(needs 90%\)/)

    const mixed = docs(20, (i) => ({ items: i % 2 ? [{ k: i }] : [{ k: i }, 'loose'] }))
    expect(surveyArrays(mixed).rejected[0].reason).toMatch(/mixes objects with other values in 10 of 20 documents/)

    const noKey = docs(10, (i) => ({ items: [{ [`k${i}`]: i }] }))
    expect(surveyArrays(noKey).rejected[0].reason).toMatch(/nothing to index/)

    // Arrays of scalars and empty arrays are never reported.
    expect(surveyArrays(docs(10, () => ({ tags: ['a'], empty: [] }))).rejected).toEqual([])
  })

  it('reports nothing for a path that is already unwound', () => {
    const registry: StorageRegistry = { ...EMPTY_REGISTRY, unwinds: [{ path: 'votes', table: 'hc_1__votes', fields: [], reason: 'r' }] }
    const batch = docs(20, (i) => ({ votes: [{ k: i }] }))
    expect(inferDecisions(input({ docs: batch, registry, rowCount: 20, elementCounts: { votes: 40 } })).pending).toEqual([])
  })
})

describe('unwind caps', () => {
  const unwound = (n: number) => Array.from({ length: n }, (_, k) => ({ path: `u${k}`, table: `hc_7__u${k}`, fields: [], reason: '' }))

  it(`creates at most MAX_UNWINDS (${MAX_UNWINDS}) unwinds per collection`, () => {
    const registry: StorageRegistry = { ...EMPTY_REGISTRY, unwinds: unwound(MAX_UNWINDS - 1) }
    const batch = docs(10, () => ({ a: [{ k: 1 }], b: [{ k: 2 }] }))
    const d = inferDecisions(input({ docs: batch, registry, rowCount: 10, elementCounts: { a: 500, b: 500 } }))
    expect(d.unwinds.map((u) => u.path)).toEqual(['a'])
    expect(d.pending).toEqual([{ path: 'b', reason: `the collection already has ${MAX_UNWINDS} unwound arrays, the most it gets.` }])
  })

  it('counts elements for a bounded number of candidates per batch, none at the cap', () => {
    const keys = Array.from({ length: 10 }, (_, k) => `arr${k}`)
    const batch = docs(10, () => Object.fromEntries(keys.map((k) => [k, [{ k: 1 }]])))
    const candidates = arrayCandidates(batch)
    expect(candidates).toHaveLength(10)
    const paths = pathsToCount(candidates, EMPTY_REGISTRY)
    expect(paths).toHaveLength(MAX_ARRAY_COUNTS_PER_BATCH)
    expect(pathsToCount(candidates, { ...EMPTY_REGISTRY, unwinds: unwound(MAX_UNWINDS) })).toEqual([])
    // Already-unwound paths are never counted again.
    expect(pathsToCount(candidates, { ...EMPTY_REGISTRY, unwinds: [{ path: 'arr0', table: 'hc_7__arr0', fields: [], reason: '' }] })).not.toContain('arr0')

    // Candidates that were not counted get a pending entry, not an unwind.
    const counts = Object.fromEntries(paths.map((p) => [p, 0]))
    const d = inferDecisions(input({ docs: batch, rowCount: 10, elementCounts: counts }))
    const notCounted = d.pending.filter((p) => p.reason.includes('was not counted'))
    expect(notCounted.map((p) => p.path).sort()).toEqual(keys.filter((k) => !paths.includes(k)).sort())
  })
})

describe('child table names', () => {
  it('gives paths that sanitize alike different tables', () => {
    const batch = docs(10, () => ({ Items: [{ k: 1 }], items: [{ k: 2 }] }))
    const d = inferDecisions(input({ docs: batch, rowCount: 10, elementCounts: { Items: 500, items: 500 } }))
    const tables = d.unwinds.map((u) => u.table)
    expect(tables).toHaveLength(2)
    expect(new Set(tables).size).toBe(2)
    expect(tables).toEqual(expect.arrayContaining(['hc_7__items', 'hc_7__items_2']))
  })

  it('avoids a name an existing unwind of another path already uses', () => {
    const registry: StorageRegistry = { ...EMPTY_REGISTRY, unwinds: [{ path: 'Items', table: 'hc_7__items', fields: [], reason: '' }] }
    expect(childTableName(7, 'items', registry)).toBe('hc_7__items_2')
    expect(childTableName(7, 'Items', registry)).toBe('hc_7__items')
    expect(childTableName(7, 'items')).toBe('hc_7__items')
  })
})
