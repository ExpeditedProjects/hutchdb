import { describe, it, expect, vi } from 'vitest'

vi.mock('./db', () => ({ db: {} }))

const { sampleMock } = vi.hoisted(() => ({ sampleMock: vi.fn() }))
vi.mock('./storage/rows', () => ({
  sampleDocuments: sampleMock,
  exactDistinctCounts: vi.fn().mockResolvedValue({}),
  estimatedDistinctCounts: vi.fn().mockResolvedValue({}),
  tableBytes: vi.fn().mockResolvedValue(0),
  fullScanMaxBytes: () => 100,
}))

import { describeFields, truncateSample, MAX_SAMPLE_STRING } from './describe'

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

describe('describeFields frequency', () => {
  it('divides by the records actually sampled, not the sample size asked for', async () => {
    // A BERNOULLI sample of a 10k-record table can come back smaller than the 500 asked for.
    sampleMock.mockResolvedValue([{ a: 1, b: 1 }, { a: 2 }, { a: 3, b: 3 }, { a: 4 }])
    const { fields } = await describeFields(1, 10_000, null)
    expect(sampleMock).toHaveBeenCalledWith(1, 500, true, 10_000)
    expect(fields.map((f) => [f.name, f.frequency])).toEqual([['a', 1], ['b', 0.5]])
  })
})
