import { describe, it, expect } from 'vitest'
import {
  arrayCandidates,
  declareFields,
  inferDecisions,
  thresholdsFromEnv,
  MAX_PROJECTIONS,
  type InferenceInput,
} from './inference'
import {
  EMPTY_REGISTRY,
  childTableName,
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
    expect(declareFields(docs(10, (i) => ({ d: `2026-01-0${i}` })))[0].type).toBe('date')
    expect(declareFields(docs(10, (i) => ({ d: `2026-01-0${i}T10:00:00Z` })))[0].type).toBe('text')
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
