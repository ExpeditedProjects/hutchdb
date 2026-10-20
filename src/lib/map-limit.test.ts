import { describe, it, expect } from 'vitest'
import { mapLimit } from './map-limit'

describe('mapLimit', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    const delays = [30, 5, 20, 1, 15, 2, 25, 3]
    const out = await mapLimit(delays, 3, async (ms, i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, ms))
      inFlight--
      return `${i}:${ms}`
    })
    expect(out).toEqual(delays.map((ms, i) => `${i}:${ms}`))
    expect(peak).toBe(3)
  })

  it('rejects with the error and starts nothing after it', async () => {
    const started: number[] = []
    await expect(mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n)
      await new Promise((r) => setTimeout(r, 5))
      if (n === 2) throw new Error('boom')
      return n
    })).rejects.toThrow('boom')
    expect(started.length).toBeLessThan(6)
  })

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})
