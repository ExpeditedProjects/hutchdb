import { describe, it, expect, vi } from 'vitest'

vi.mock('./db', () => ({ db: {} }))
vi.mock('./db/queries', () => ({ notDeleted: {} }))

import { truncateSample, MAX_SAMPLE_STRING } from './describe'

describe('truncateSample', () => {
  it('cuts long strings to MAX_SAMPLE_STRING characters with an ellipsis', () => {
    const long = 'x'.repeat(5000)
    expect(truncateSample(long)).toBe(`${'x'.repeat(MAX_SAMPLE_STRING)}…`)
    expect(MAX_SAMPLE_STRING).toBe(200)
    expect(truncateSample('short')).toBe('short')
    expect(truncateSample(42)).toBe(42)
    expect(truncateSample(null)).toBeNull()
  })

  it('keeps the first elements of an array and the first keys of nested objects, truncated in turn', () => {
    const answers = Array.from({ length: 22 }, (_, i) => ({ answer_id: i, body: 'b'.repeat(3000), author: { name: 'A', id: i, rep: 1, extra: true } }))
    const sample = truncateSample(answers) as unknown[]
    expect(sample).toHaveLength(4)
    expect(sample[3]).toBe('… 19 more')
    const first = sample[0] as Record<string, unknown>
    expect((first.body as string).length).toBe(MAX_SAMPLE_STRING + 1)
    expect(first.author).toEqual({ name: 'A', id: 0, rep: 1, '…': '1 more keys' })
    expect(JSON.stringify(sample).length).toBeLessThan(2000)
  })
})
