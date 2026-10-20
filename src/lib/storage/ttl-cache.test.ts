import { describe, it, expect } from 'vitest'
import { TtlCache } from './ttl-cache'

describe('TtlCache', () => {
  it('expires entries after the TTL', () => {
    let now = 1000
    const cache = new TtlCache<number>(100, 10, () => now)
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
    now = 1099
    expect(cache.get('a')).toBe(1)
    now = 1100
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('never holds more than maxEntries: expired entries go first, then the oldest', () => {
    let now = 0
    const cache = new TtlCache<string>(100, 3, () => now)
    cache.set('old', 'x') // expires at 100
    now = 50
    cache.set('b', 'b')
    cache.set('c', 'c')
    now = 120 // 'old' has expired
    cache.set('d', 'd')
    expect(cache.size).toBe(3)
    expect(cache.get('old')).toBeUndefined()
    expect([cache.get('b'), cache.get('c'), cache.get('d')]).toEqual(['b', 'c', 'd'])
    // Nothing expired: the oldest live entry makes room.
    cache.set('e', 'e')
    expect(cache.size).toBe(3)
    expect(cache.get('b')).toBeUndefined()
    expect([cache.get('c'), cache.get('d'), cache.get('e')]).toEqual(['c', 'd', 'e'])
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, 'v')
    expect(cache.size).toBe(3)
  })

  it('re-setting a key refreshes its value and expiry', () => {
    let now = 0
    const cache = new TtlCache<number>(100, 3, () => now)
    cache.set('a', 1)
    now = 90
    cache.set('a', 2)
    now = 150
    expect(cache.get('a')).toBe(2)
  })
})
