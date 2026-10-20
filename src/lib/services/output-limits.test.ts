import { describe, it, expect } from 'vitest'
import { limitQueryOutput, rowsThatFit, truncateStrings, truncationMarker } from './output-limits'

describe('truncateStrings', () => {
  it('cuts strings over the cap at any depth with a marker saying how much was cut', () => {
    const long = 'a'.repeat(2500)
    const { value, truncated } = truncateStrings({ body: long, nested: { list: ['short', long] }, n: 5 }, 2000)
    expect(truncated).toBe(2)
    expect(value.body).toBe('a'.repeat(2000) + truncationMarker(500))
    expect(value.body).toMatch(/…\[truncated: 500 more chars; pass max_string_length: 0 for full values\]$/)
    expect(value.nested.list).toEqual(['short', 'a'.repeat(2000) + truncationMarker(500)])
    expect(value.n).toBe(5)
  })

  it('leaves strings at or under the cap, Dates and keys alone, and does nothing with max 0', () => {
    const date = new Date('2026-10-20T00:00:00Z')
    const input = { exact: 'b'.repeat(10), at: date, ['k'.repeat(50)]: 1 }
    expect(truncateStrings(input, 10)).toEqual({ value: input, truncated: 0 })
    expect(truncateStrings(input, 10).value.at).toBe(date)
    expect(truncateStrings({ s: 'x'.repeat(100) }, 0)).toEqual({ value: { s: 'x'.repeat(100) }, truncated: 0 })
  })

  it('never splits a surrogate pair', () => {
    const s = 'a' + '😀'.repeat(5) // 'a' + 10 UTF-16 units
    const { value } = truncateStrings(s, 2) // unit 2 is the high half of the first emoji
    expect(value.startsWith('a…')).toBe(true)
    expect(value).toContain('truncated: 10 more chars')
  })
})

describe('rowsThatFit', () => {
  it('keeps the leading rows that fit and always at least one', () => {
    const rows = Array.from({ length: 5 }, () => ({ s: 'x'.repeat(100) }))
    expect(rowsThatFit(rows, 1_000_000)).toBe(5)
    expect(rowsThatFit(rows, 250)).toBe(2)
    expect(rowsThatFit(rows, 10)).toBe(1)
    expect(rowsThatFit([], 10)).toBe(0)
  })
})

describe('limitQueryOutput', () => {
  const page = (n: number, size: number, offset = 0, total = 100) => ({
    records: Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, data: { body: 'x'.repeat(size) } })),
    total, count: n, limit: n, offset, has_more: offset + n < total, next_offset: offset + n < total ? offset + n : null, indexed: false, plan: 'Seq Scan',
  })

  it('cuts strings and reports how many', () => {
    const out = limitQueryOutput(page(3, 3000), { maxStringLength: 2000 })
    expect(out.truncated_strings).toBe(3)
    expect((out.records![0] as { data: { body: string } }).data.body).toMatch(/truncated: 1000 more chars/)
    expect(out.page_note).toBeUndefined()
  })

  it('cuts an oversized page short and points next_offset at the first row left out', () => {
    const out = limitQueryOutput(page(50, 10_000, 20, 100), { maxStringLength: 0, maxPageChars: 200_000 })
    expect(out.count).toBeLessThan(50)
    expect(out.records).toHaveLength(out.count)
    expect(out.has_more).toBe(true)
    expect(out.next_offset).toBe(20 + out.count)
    expect(out.page_note).toMatch(new RegExp(`^Returned ${out.count} of the 50 records`))
    expect(JSON.stringify(out.records).length).toBeLessThanOrEqual(200_000)
    expect(out.truncated_strings).toBeUndefined()
  })

  it('treats aggregate results the same way and leaves small pages alone', () => {
    const agg = { results: [{ k: 'y'.repeat(5000), n: 1 }], total: 1, count: 1, limit: 50, offset: 0, has_more: false, next_offset: null }
    const out = limitQueryOutput(agg, { maxStringLength: 100, maxPageChars: 200_000 })
    expect((out.results![0] as { k: string }).k).toMatch(/^y{100}…\[truncated: 4900/)
    expect(out).toMatchObject({ count: 1, has_more: false, next_offset: null })
    const small = page(2, 10)
    expect(limitQueryOutput(small, { maxStringLength: 2000, maxPageChars: 200_000 })).toEqual(small)
  })
})
