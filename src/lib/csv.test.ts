import { describe, it, expect } from 'vitest'
import {
  escapeCsvField,
  toCsv,
  parseCsv,
  coerceCsvValue,
  recordsToCsv,
  csvToRecords,
  type ExportRow,
} from './csv'

describe('escapeCsvField (RFC 4180)', () => {
  it('leaves plain values unquoted', () => {
    expect(escapeCsvField('hello')).toBe('hello')
  })

  it('quotes values containing commas', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
  })

  it('quotes and doubles embedded quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes values containing newlines', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"')
  })
})

describe('parseCsv', () => {
  it('parses a simple grid', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('handles LF-only and CRLF line endings', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('parses quoted fields with embedded commas', () => {
    expect(parseCsv('a\r\n"x, y"\r\n')).toEqual([['a'], ['x, y']])
  })

  it('parses doubled quotes inside quoted fields', () => {
    expect(parseCsv('a\r\n"say ""hi"""\r\n')).toEqual([['a'], ['say "hi"']])
  })

  it('parses embedded newlines inside quoted fields', () => {
    expect(parseCsv('a,b\r\n"line1\r\nline2",2\r\n')).toEqual([['a', 'b'], ['line1\r\nline2', '2']])
  })

  it('handles empty cells and a trailing newline without a phantom row', () => {
    expect(parseCsv('a,b,c\r\n1,,3\r\n')).toEqual([['a', 'b', 'c'], ['1', '', '3']])
  })

  it('round-trips through toCsv for adversarial values', () => {
    const rows = [['plain', 'has,comma', 'has "quotes"', 'multi\nline', '']]
    const parsed = parseCsv(toCsv(['a', 'b', 'c', 'd', 'e'], rows))
    expect(parsed).toEqual([['a', 'b', 'c', 'd', 'e'], ...rows])
  })
})

describe('coerceCsvValue', () => {
  it('returns undefined for empty cells (field omitted)', () => {
    expect(coerceCsvValue('')).toBeUndefined()
  })

  it('coerces booleans', () => {
    expect(coerceCsvValue('true')).toBe(true)
    expect(coerceCsvValue('false')).toBe(false)
  })

  it('coerces numeric strings to numbers', () => {
    expect(coerceCsvValue('42')).toBe(42)
    expect(coerceCsvValue('-3.14')).toBe(-3.14)
    expect(coerceCsvValue('0')).toBe(0)
  })

  it('keeps leading-zero and non-numeric strings as strings', () => {
    expect(coerceCsvValue('007')).toBe('007')
    expect(coerceCsvValue('1.2.3')).toBe('1.2.3')
    expect(coerceCsvValue('2026-08-22')).toBe('2026-08-22')
  })

  it('parses JSON-looking cells so nested values round-trip', () => {
    expect(coerceCsvValue('{"a":1}')).toEqual({ a: 1 })
    expect(coerceCsvValue('[1,2]')).toEqual([1, 2])
  })

  it('keeps invalid JSON-looking cells as strings', () => {
    expect(coerceCsvValue('{not json')).toBe('{not json')
  })
})

describe('recordsToCsv', () => {
  const rows: ExportRow[] = [
    {
      id: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      data: { title: 'First', tags: ['a', 'b'] },
    },
    {
      id: 2,
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-04T00:00:00.000Z',
      data: { title: 'Second, with comma', extra: { nested: true } },
    },
  ]

  it('emits system columns first, then the union of data keys in first-seen order', () => {
    const csv = recordsToCsv(rows)
    const [header] = parseCsv(csv)
    expect(header).toEqual(['id', 'created_at', 'updated_at', 'title', 'tags', 'extra'])
  })

  it('JSON-stringifies nested objects and arrays into cells', () => {
    const parsed = parseCsv(recordsToCsv(rows))
    expect(parsed[1][4]).toBe('["a","b"]')
    expect(parsed[2][5]).toBe('{"nested":true}')
  })

  it('leaves cells empty for records missing a key', () => {
    const parsed = parseCsv(recordsToCsv(rows))
    expect(parsed[1][5]).toBe('') // row 1 has no `extra`
    expect(parsed[2][4]).toBe('') // row 2 has no `tags`
  })
})

describe('csvToRecords', () => {
  it('requires a header row', () => {
    expect(csvToRecords('')).toEqual(expect.objectContaining({ error: expect.any(String) }))
  })

  it('infers types and omits empty cells', () => {
    const result = csvToRecords('name,age,active,note\r\nAlice,30,true,\r\nBob,007,false,hello\r\n')
    expect(result).toEqual({
      records: [
        { name: 'Alice', age: 30, active: true },
        { name: 'Bob', age: '007', active: false, note: 'hello' },
      ],
    })
  })

  it('ignores system columns so exports round-trip without polluting data', () => {
    const result = csvToRecords('id,created_at,updated_at,title\r\n1,2026-01-01,2026-01-02,Hello\r\n')
    expect(result).toEqual({ records: [{ title: 'Hello' }] })
  })

  it('skips fully-empty rows', () => {
    const result = csvToRecords('a,b\r\n1,2\r\n,\r\n3,4\r\n')
    expect(result).toEqual({ records: [{ a: 1, b: 2 }, { a: 3, b: 4 }] })
  })

  it('handles quoted values with commas, quotes, and newlines', () => {
    const result = csvToRecords('note\r\n"has, comma"\r\n"say ""hi"""\r\n"line1\nline2"\r\n')
    expect(result).toEqual({
      records: [{ note: 'has, comma' }, { note: 'say "hi"' }, { note: 'line1\nline2' }],
    })
  })
})

describe('export -> import round-trip', () => {
  it('recordsToCsv output parses back to the original data via csvToRecords', () => {
    const original: ExportRow[] = [
      {
        id: 10,
        created_at: '2026-05-01T12:00:00.000Z',
        updated_at: '2026-05-02T12:00:00.000Z',
        data: {
          title: 'Widget, deluxe "edition"',
          price: 19.99,
          in_stock: true,
          tags: ['a', 'b'],
          meta: { color: 'red', sizes: [1, 2] },
          notes: 'first line\nsecond line',
        },
      },
      {
        id: 11,
        created_at: '2026-05-03T12:00:00.000Z',
        updated_at: '2026-05-04T12:00:00.000Z',
        data: { title: 'Gadget', price: 5, in_stock: false },
      },
    ]

    const result = csvToRecords(recordsToCsv(original))
    expect(result).toEqual({ records: original.map((r) => r.data) })
  })
})
