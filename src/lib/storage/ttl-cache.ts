/**
 * A small in-process cache with a TTL and a size cap, for the compiler's
 * per-collection probes and EXPLAIN reports. When a set would exceed
 * `maxEntries`, expired entries are pruned first, then the oldest
 * (insertion order) until it fits.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    const now = this.now();
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
      for (const k of this.entries.keys()) {
        if (this.entries.size < this.maxEntries) break;
        this.entries.delete(k);
      }
    }
    this.entries.set(key, { value, expires: now + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}
