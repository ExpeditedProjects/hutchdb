import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Query features against real Postgres, each checked against an in-memory
// oracle and between a projected/unwound collection and an identical one
// evaluated over the documents only:
// - time_bucket on a data field holding ISO date/datetime strings (UTC);
// - $size on arrays and objects (maps), in filters and aggregates;
// - warnings for a group_by path that never resolves (a map, a typo);
// - arithmetic expressions in aggregates, per element over an array.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;

const USER_ID = "features-user";
const ORG_ID = "features-org";

type RecordsService = typeof import("@/lib/services/records");
type QueryParams = Parameters<RecordsService["queryRecords"]>[2];
type QueryResult = Record<string, unknown> & {
  records?: { id: number; data: unknown }[];
  results?: Record<string, unknown>[];
  total?: number;
  indexed?: boolean;
  plan?: string;
  warnings?: string[];
};

function ok<T>(result: T): Exclude<T, { error: unknown } | null | undefined> {
  if (result == null || (typeof result === "object" && "error" in (result as object))) {
    throw new Error(`Expected success result, got: ${JSON.stringify(result)}`);
  }
  return result as Exclude<T, { error: unknown } | null | undefined>;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ── time_bucket oracle ──────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}(:?\d{2})?)?)?$/;
const ZONED_RE = /[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}(:?\d{2})?)$/;

/** The UTC bucket label of a value, or null for anything that is not a valid ISO date/datetime string. */
function bucketOf(v: unknown, unit: "hour" | "day" | "week" | "month" | "year"): string | null {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const [y0, m0, d0] = v.slice(0, 10).split("-").map(Number);
  const check = new Date(Date.UTC(y0, m0 - 1, d0));
  if (check.getUTCMonth() !== m0 - 1 || check.getUTCDate() !== d0) return null;
  const text = v.length === 10 ? `${v}T00:00:00Z` : ZONED_RE.test(v) ? v : `${v}Z`;
  const d = new Date(text.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const ms = unit === "hour" ? Date.UTC(y, m, day, d.getUTCHours())
    : unit === "day" ? Date.UTC(y, m, day)
    : unit === "week" ? Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7))
    : unit === "month" ? Date.UTC(y, m, 1)
    : Date.UTC(y, 0, 1);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Counts per bucket, sorted by bucket with the null bucket last (the default aggregate order). */
function bucketCounts<T>(docs: T[], value: (d: T) => unknown[], unit: "hour" | "day" | "week" | "month" | "year") {
  const counts = new Map<string | null, number>();
  for (const d of docs) for (const v of value(d)) {
    const b = bucketOf(v, unit);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => (x[0] === null ? 1 : y[0] === null ? -1 : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([time_bucket, n]) => ({ time_bucket, n }));
}

const BASE = Date.UTC(2026, 8, 20, 0, 0, 0);

function offsetIso(ms: number, hours: number): string {
  const local = new Date(ms + hours * 3600_000).toISOString().slice(0, 19);
  const sign = hours >= 0 ? "+" : "-";
  return `${local}${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

type Event = { n: number; event: string; ts?: unknown; day: string; logins: { at: unknown; ok: boolean }[] };

function makeEvents(count: number, clean = false): Event[] {
  return range(count).map((i) => {
    const ms = BASE + i * 4 * 3600_000 + i * 61_000; // every ~4h, drifting minutes
    let ts: unknown = new Date(ms).toISOString();
    if (!clean) {
      switch (i % 25) {
        case 0: ts = undefined; break;
        case 1: ts = "not a date"; break;
        case 2: ts = "2026-02-30T10:00:00Z"; break;
        case 3: ts = 12345; break;
        case 4: ts = new Date(ms).toISOString().slice(0, 19); break; // naive: read as UTC
        case 5: ts = offsetIso(ms, 5); break; // same instant, +05:00 (often another local day)
        case 6: ts = offsetIso(ms, -7); break;
        case 7: ts = new Date(ms).toISOString().slice(0, 10); break; // date only
        case 8: ts = new Date(ms).toISOString().replace("T", " "); break;
      }
    } else if (i % 3 === 0) {
      ts = offsetIso(ms, 9);
    }
    const ev: Event = {
      n: i,
      event: ["view", "click", "signup"][i % 3],
      day: new Date(ms).toISOString().slice(0, 10),
      logins: [
        { at: new Date(ms - 86_400_000 * 40).toISOString(), ok: i % 2 === 0 },
        { at: i % 17 === 0 ? "soon" : offsetIso(ms - 86_400_000 * 3, -3), ok: true },
      ],
    };
    if (ts !== undefined) ev.ts = ts;
    return ev;
  });
}

// ── $size oracle ────────────────────────────────────────────────────────────

function sizeOf(v: unknown): number | null {
  if (Array.isArray(v)) return v.length;
  if (v !== null && typeof v === "object") return Object.keys(v).length;
  return null;
}

function valueAt(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function sizeMatches(doc: unknown, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, spec]) => {
    if (field === "$or") return (spec as Record<string, unknown>[]).some((b) => sizeMatches(doc, b));
    if (spec === null || typeof spec !== "object") return valueAt(doc, field) === spec;
    const ops = spec as Record<string, unknown>;
    const s = sizeOf(valueAt(doc, field));
    if (s === null) return false;
    const cond = ops.$size;
    if (typeof cond === "number") return s === cond;
    return Object.entries(cond as Record<string, number>).every(([op, x]) =>
      op === "$gt" ? s > x : op === "$gte" ? s >= x : op === "$lt" ? s < x : op === "$lte" ? s <= x : op === "$ne" ? s !== x : false);
  });
}

type Org = { org_id: number; plan: string; members?: unknown; tags?: unknown; org: { team: { list: number[] } } };

function makeOrgs(count: number): Org[] {
  return range(count).map((i) => {
    const o: Org = { org_id: i, plan: ["free", "pro", "enterprise"][i % 3], org: { team: { list: range(i % 4) } } };
    if (i % 20 !== 0) {
      o.members = i % 20 === 1 ? "solo" : i % 20 === 2 ? {} : Object.fromEntries(range(i % 45).map((k) => [`u${i}_${k}`, { role: k % 3 ? "member" : "admin", active: k % 2 === 0 }]));
    }
    if (i % 11 !== 0) o.tags = i % 7 === 0 ? [] : i % 7 === 1 ? "single" : range(i % 5).map((k) => `t${k}`);
    return o;
  });
}

// ── orders fixture (agent-test R2) ──────────────────────────────────────────

type Item = { sku: string; qty: unknown; price?: number; category: string };
type Order = { order_id: string; status: string; discount: number; items: Item[] };

/** Prices in integer cents, varying per order so revenue must be summed per line item. */
function makeOrders(count: number): Order[] {
  return range(count).map((i) => ({
    order_id: `ORD-${String(i).padStart(4, "0")}`,
    status: ["delivered", "shipped", "cancelled"][i % 3],
    discount: i % 4 === 0 ? 0.5 : 1,
    items: range(3 + (i % 4)).map((k) => {
      const s = (i * 7 + k * 3) % 11;
      const item: Item = { sku: `SKU-${String(s).padStart(2, "0")}`, qty: 1 + ((i + k) % 5), price: (1000 + s * 137 + (i % 3)) / 100, category: k % 2 ? "a" : "b" };
      if ((i + k) % 53 === 0) item.qty = "2"; // not a number: that line's product is null
      if ((i + k) % 61 === 0) delete item.price;
      return item;
    }),
  }));
}

const cents = (x: number) => Math.round(x * 100);

describe.skipIf(!TEST_DB_URL)("query features against real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let recordsSvc: RecordsService;
  const ENV_KEYS = ["HUTCH_DATABASE_URL", "HUTCH_PROJECT_THRESHOLD", "HUTCH_UNWIND_THRESHOLD"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  function thresholds(project: number, unwind = project) {
    process.env.HUTCH_PROJECT_THRESHOLD = String(project);
    process.env.HUTCH_UNWIND_THRESHOLD = String(unwind);
  }

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    await migrate(testDb, { migrationsFolder });

    recordsSvc = await import("@/lib/services/records");
    appPool = (await import("@/lib/db")).db.$client as Pool;

    await testDb.insert(schema.user).values({ id: USER_ID, email: "features@hutch.test", name: "Features" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "features", name: "Features", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    thresholds(100);
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  async function store(collection: string, recs: Record<string, unknown>[]): Promise<string> {
    const result = ok(await recordsSvc.createRecords(USER_ID, ORG_ID, { collection, records: recs, return: "summary" }));
    return (result as { collection: { slug: string } }).collection.slug;
  }

  async function registry(slug: string) {
    const { readRegistry } = await import("./registry");
    const [row] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slug));
    return readRegistry(row.storage);
  }

  async function query(slug: string, params: QueryParams): Promise<QueryResult> {
    return ok(await recordsSvc.queryRecords(slug, USER_ID, params)) as QueryResult;
  }

  /** The same documents stored twice: projected/unwound at 100, and never (documents only). */
  async function twin(docs: Record<string, unknown>[]) {
    thresholds(100);
    const projected = await store("projected", docs);
    thresholds(1_000_000_000);
    const plain = await store("plain", docs);
    thresholds(100);
    return { projected, plain };
  }

  async function both(slugs: { projected: string; plain: string }, params: QueryParams) {
    return Promise.all([query(slugs.projected, params), query(slugs.plain, params)]);
  }

  // ── 1. time_bucket on a data field ─────────────────────────────────────────

  describe("time_bucket on a data field", () => {
    it("buckets ISO strings by UTC day/hour/week/month/year, others in the null bucket, projected or not", async () => {
      const docs = makeEvents(300);
      const slugs = await twin(docs);
      const ts = (await registry(slugs.projected)).projections.find((p) => p.field === "ts");
      expect(ts).toMatchObject({ type: "text", mixed: true });
      for (const unit of ["day", "hour", "week", "month", "year"] as const) {
        const params: QueryParams = { timeBucket: { field: "ts", unit }, aggregate: { n: "count" }, limit: 1000 };
        const [a, b] = await both(slugs, params);
        const expected = bucketCounts(docs, (d) => [d.ts], unit);
        expect(a.results, `projected ${unit}`).toEqual(expected);
        expect(b.results, `plain ${unit}`).toEqual(expected);
        expect(a.total).toBe(expected.length);
      }
      // The null bucket holds the missing, non-string and invalid values (including 2026-02-30).
      const nulls = docs.filter((d) => bucketOf(d.ts, "day") === null).length;
      expect(nulls).toBe(4 * 12);
    });

    it("an unmixed text projection and a date projection give the same buckets as the documents", async () => {
      const docs = makeEvents(300, true);
      const slugs = await twin(docs);
      const reg = await registry(slugs.projected);
      expect(reg.projections.find((p) => p.field === "ts")).toMatchObject({ type: "text" });
      expect(reg.projections.find((p) => p.field === "ts")?.mixed).toBeFalsy();
      expect(reg.projections.find((p) => p.field === "day")).toMatchObject({ type: "date" });
      for (const [field, unit] of [["ts", "day"], ["day", "week"], ["day", "month"]] as const) {
        const [a, b] = await both(slugs, { timeBucket: { field, unit }, aggregate: { n: "count" }, limit: 1000 });
        const expected = bucketCounts(docs, (d) => [d[field]], unit);
        expect(a.results, `${field} ${unit}`).toEqual(expected);
        expect(b.results).toEqual(expected);
      }
    });

    it("composes with filter, group_by, aggregate, sort and limit", async () => {
      const docs = makeEvents(300);
      const slugs = await twin(docs);
      const params: QueryParams = {
        filter: { event: { $in: ["signup", "click"] } },
        groupBy: "event",
        timeBucket: { field: "ts", unit: "day" },
        aggregate: { n: "count", s: { sum: "n" } },
        sort: ["-time_bucket", "event"],
        limit: 5,
      };
      const groups = new Map<string, { time_bucket: string | null; event: string; n: number; s: number }>();
      for (const d of docs.filter((x) => x.event !== "view")) {
        const b = bucketOf(d.ts, "day");
        const key = `${b}|${d.event}`;
        const g = groups.get(key) ?? { time_bucket: b, event: d.event, n: 0, s: 0 };
        g.n++;
        g.s += d.n;
        groups.set(key, g);
      }
      const all = [...groups.values()].sort((x, y) =>
        x.time_bucket === y.time_bucket ? x.event.localeCompare(y.event)
          : x.time_bucket === null ? 1 : y.time_bucket === null ? -1 : y.time_bucket.localeCompare(x.time_bucket));
      const [a, b] = await both(slugs, params);
      expect(a.results).toEqual(all.slice(0, 5));
      expect(b.results).toEqual(all.slice(0, 5));
      expect(a.total).toBe(all.length);
    });

    it("buckets a path into an array of objects per element, unwound or not", async () => {
      const docs = makeEvents(300);
      const slugs = await twin(docs);
      expect((await registry(slugs.projected)).unwinds.map((u) => u.path)).toEqual(["logins"]);
      const [a, b] = await both(slugs, { timeBucket: { field: "logins.at", unit: "week" }, aggregate: { n: "count", ok: { sum: "logins.ok" } }, limit: 1000 });
      const counts = new Map<string | null, { n: number; ok: number }>();
      for (const d of docs) for (const l of d.logins) {
        const k = bucketOf(l.at, "week");
        const g = counts.get(k) ?? { n: 0, ok: 0 };
        g.n++;
        g.ok += l.ok ? 1 : 0;
        counts.set(k, g);
      }
      const expected = [...counts.entries()].sort((x, y) => (x[0] === null ? 1 : y[0] === null ? -1 : x[0].localeCompare(y[0]))).map(([time_bucket, g]) => ({ time_bucket, ...g }));
      expect(a.results).toEqual(expected);
      expect(b.results).toEqual(expected);
    });

    it("the string form still buckets on created_at; bad specs are errors; a field with no dates warns", async () => {
      const docs = makeEvents(60);
      const slug = await store("events", docs);
      const created = await query(slug, { timeBucket: "day", aggregate: { n: "count" } });
      expect(created.results).toHaveLength(1);
      expect(created.results![0].n).toBe(60);

      await expect(query(slug, { timeBucket: { field: "ts", unit: "fortnight" } as never, aggregate: { n: "count" } })).rejects.toThrow(/time_bucket unit 'fortnight'/);
      await expect(query(slug, { timeBucket: { field: "ts; drop", unit: "day" }, aggregate: { n: "count" } })).rejects.toThrow(/Invalid field name/);
      await expect(query(slug, { timeBucket: { field: "ts", unit: "day", tz: "x" } as never, aggregate: { n: "count" } })).rejects.toThrow(/time_bucket takes/);
      await expect(query(slug, { timeBucket: { unit: "day" } as never, aggregate: { n: "count" } })).rejects.toThrow(/time_bucket takes/);

      const none = await query(slug, { timeBucket: { field: "event", unit: "day" }, aggregate: { n: "count" } });
      expect(none.results).toEqual([{ time_bucket: null, n: 60 }]);
      expect(none.warnings).toEqual([expect.stringMatching(/time_bucket field 'event'.*ISO date/)]);
    });
  });

  // ── 2. $size ───────────────────────────────────────────────────────────────

  describe("$size on arrays and objects", () => {
    const FILTERS: Record<string, unknown>[] = [
      { members: { $size: 3 } },
      { members: { $size: { $gt: 30 } } },
      { members: { $size: { $gte: 2, $lt: 5 } } },
      { members: { $size: { $ne: 0 } } },
      { members: { $size: 0 } },
      { tags: { $size: 0 } },
      { tags: { $size: { $lte: 2 } } },
      { "org.team.list": { $size: 2 } },
      { $or: [{ members: { $size: { $gt: 40 } } }, { tags: { $size: 4 } }] },
      { plan: "pro", members: { $size: { $lt: 10 } } },
    ];

    it("counts array elements and object keys; scalars and missing values never match, projected or not", async () => {
      const docs = makeOrgs(300);
      const slugs = await twin(docs);
      for (const filter of FILTERS) {
        const params: QueryParams = { filter, sort: "org_id", limit: 1000, fields: ["org_id"] };
        const [a, b] = await both(slugs, params);
        const expected = docs.filter((d) => sizeMatches(d, filter)).map((d) => d.org_id);
        expect(a.records!.map((r) => (r.data as Org).org_id), `${JSON.stringify(filter)} projected`).toEqual(expected);
        expect(b.records!.map((r) => (r.data as Org).org_id), `${JSON.stringify(filter)} plain`).toEqual(expected);
        const count = await query(slugs.projected, { filter, limit: 0 });
        expect(count.total).toBe(expected.length);
      }
      expect(docs.filter((d) => sizeMatches(d, { members: { $size: { $gt: 30 } } })).length).toBeGreaterThan(20);
    });

    it("validates its operand strictly", async () => {
      const slug = await store("orgs", makeOrgs(20));
      for (const bad of ["3", [3], { $gt: "a" }, { $regex: 1 }, { $gt: { $lt: 1 } }, {}, null, true]) {
        await expect(query(slug, { filter: { members: { $size: bad } } }), JSON.stringify(bad)).rejects.toThrow(/\$size/);
      }
    });

    it("works as an aggregate operand: avg/max/sum of {$size: path}", async () => {
      const docs = makeOrgs(300);
      const slugs = await twin(docs);
      const params: QueryParams = { groupBy: "plan", aggregate: { avg_m: { avg: { $size: "members" } }, max_m: { max: { $size: "members" } }, total: { sum: { $size: "members" } }, n: "count" }, limit: 10 };
      const [a, b] = await both(slugs, params);
      const expected = ["enterprise", "free", "pro"].map((plan) => {
        const sizes = docs.filter((d) => d.plan === plan).map((d) => sizeOf(d.members)).filter((s): s is number => s !== null);
        return { plan, total: sizes.reduce((x, y) => x + y, 0), max_m: Math.max(...sizes), avg: sizes.reduce((x, y) => x + y, 0) / sizes.length, n: docs.filter((d) => d.plan === plan).length };
      });
      expect(a.results).toEqual(b.results);
      expect(a.results!.map((r) => r.plan)).toEqual(expected.map((e) => e.plan));
      a.results!.forEach((r, i) => {
        expect(r).toMatchObject({ total: expected[i].total, max_m: expected[i].max_m, n: expected[i].n });
        expect(r.avg_m as number).toBeCloseTo(expected[i].avg, 10);
      });
    });
  });

  // ── 3. group_by on a path that never resolves ──────────────────────────────

  describe("group_by on a path that never resolves", () => {
    it("warns naming the path, and says when it runs through objects (a map); never an error", async () => {
      const docs = makeOrgs(300);
      const slugs = await twin(docs);
      for (const slug of [slugs.projected, slugs.plain]) {
        const map = await query(slug, { groupBy: "members.role", aggregate: { n: "count" } });
        expect(map.results).toEqual([{ "members.role": null, n: 300 }]);
        expect(map.warnings).toHaveLength(1);
        expect(map.warnings![0]).toMatch(/group_by 'members\.role'/);
        expect(map.warnings![0]).toMatch(/'members' holds objects/);
        expect(map.warnings![0]).toMatch(/\$size/);
        expect(map.warnings![0]).toMatch(/hutch_describe_collection/);

        const typo = await query(slug, { groupBy: "plann", aggregate: { n: "count" } });
        expect(typo.results).toEqual([{ plann: null, n: 300 }]);
        expect(typo.warnings).toEqual([expect.stringMatching(/group_by 'plann' is null in every group.*hutch_describe_collection/)]);
        expect(typo.warnings![0]).not.toMatch(/holds objects/);

        // Two keys, one never resolving: still warned about that one.
        const two = await query(slug, { groupBy: ["plan", "nope.deeper"], aggregate: { n: "count" } });
        expect(two.results).toHaveLength(3);
        expect(two.warnings).toEqual([expect.stringMatching(/group_by 'nope\.deeper'/)]);

        const fine = await query(slug, { groupBy: "plan", aggregate: { n: "count" } });
        expect(fine.warnings).toBeUndefined();
      }
    });
  });

  // ── 4. computed aggregates ─────────────────────────────────────────────────

  describe("arithmetic expressions in aggregates", () => {
    it("SKU revenue = sum of qty x price over delivered orders, per line item, unwound or not (agent-test R2)", async () => {
      const docs = makeOrders(300);
      const slugs = await twin(docs);
      expect((await registry(slugs.projected)).unwinds.map((u) => u.path)).toEqual(["items"]);
      const per = new Map<string, { rev: number; n: number; any: boolean }>();
      for (const o of docs.filter((d) => d.status === "delivered")) {
        for (const it of o.items) {
          const g = per.get(it.sku) ?? { rev: 0, n: 0, any: false };
          g.n++;
          if (typeof it.qty === "number" && typeof it.price === "number") {
            g.rev += it.qty * cents(it.price);
            g.any = true;
          }
          per.set(it.sku, g);
        }
      }
      // Prices vary per order, so sum(qty) x price would be wrong: the check is meaningful.
      const prices = new Set(docs.flatMap((o) => o.items.filter((i) => i.sku === "SKU-03").map((i) => i.price)));
      expect(prices.size).toBeGreaterThan(1);
      const expected = [...per.entries()].map(([sku, g]) => ({ "items.sku": sku, revenue: g.any ? g.rev / 100 : null, n: g.n }))
        .sort((x, y) => (y.revenue ?? -1) - (x.revenue ?? -1));
      const params: QueryParams = { filter: { status: "delivered" }, groupBy: "items.sku", aggregate: { revenue: { sum: { $multiply: ["items.qty", "items.price"] } }, n: "count" }, sort: "-revenue", limit: 100 };
      const [a, b] = await both(slugs, params);
      expect(a.results).toEqual(expected);
      expect(b.results).toEqual(expected);
      // The unwound collection answers from its child table, the other by unnesting the documents.
      const { compileQuery, renderSql } = await import("./compiler");
      const [row] = await testDb.select().from(schema.collections).where(eq(schema.collections.slug, slugs.projected));
      const childTable = (await registry(slugs.projected)).unwinds[0].table;
      expect(renderSql(compileQuery(row, params).query)).toContain(`FROM "${childTable}" c JOIN`);
    });

    it("$add, $subtract, $divide (by zero is null), literals, parent fields per element and nesting agree across storage", async () => {
      const docs = makeOrders(300);
      const slugs = await twin(docs);
      const params: QueryParams = {
        groupBy: "items.category",
        aggregate: {
          disc: { sum: { $multiply: ["items.qty", "items.price", "discount"] } },
          half: { sum: { $divide: ["items.price", 2] } },
          plus: { max: { $add: ["items.qty", 10] } },
          diff: { min: { $subtract: ["items.qty", "items.price"] } },
          zero: { max: { $divide: ["items.qty", { $subtract: ["items.qty", "items.qty"] }] } },
          avg_line: { avg: { $multiply: [{ $add: ["items.qty", 0] }, "items.price"] } },
        },
        limit: 10,
      };
      const [a, b] = await both(slugs, params);
      expect(a.results).toEqual(b.results);
      for (const row of a.results!) {
        const items = docs.flatMap((o) => o.items.map((i) => ({ ...i, discount: o.discount }))).filter((i) => i.category === row["items.category"]);
        const num = items.filter((i) => typeof i.qty === "number" && typeof i.price === "number") as (Item & { qty: number; price: number; discount: number })[];
        expect(row.disc as number).toBeCloseTo(num.reduce((s, i) => s + i.qty * i.price * i.discount, 0), 6);
        expect(row.half as number).toBeCloseTo(items.filter((i) => typeof i.price === "number").reduce((s, i) => s + i.price! / 2, 0), 6);
        expect(row.plus).toBe(Math.max(...items.filter((i) => typeof i.qty === "number").map((i) => (i.qty as number) + 10)));
        expect(row.diff as number).toBeCloseTo(Math.min(...num.map((i) => i.qty - i.price)), 6);
        expect(row.zero).toBeNull();
        expect(row.avg_line as number).toBeCloseTo(num.reduce((s, i) => s + i.qty * i.price, 0) / num.length, 6);
      }
    });

    it("works without arrays too, and alongside $size", async () => {
      const docs = makeOrders(120);
      const slugs = await twin(docs);
      const [a, b] = await both(slugs, { aggregate: { d: { sum: { $multiply: ["discount", 2] } }, lines: { avg: { $size: "items" } } } });
      expect(a.results).toEqual(b.results);
      expect(a.results![0].d as number).toBeCloseTo(docs.reduce((s, o) => s + o.discount * 2, 0), 10);
      expect(a.results![0].lines as number).toBeCloseTo(docs.reduce((s, o) => s + o.items.length, 0) / docs.length, 10);
    });

    it("rejects malformed expressions with a message naming the problem", async () => {
      const slug = await store("orders", makeOrders(20));
      const bad: [unknown, RegExp][] = [
        [{ sum: { $add: [{ $add: [{ $add: [{ $add: [1, "items.qty"] }, 1] }, 1] }, 1] } }, /nested at most 3/],
        [{ sum: { $pow: ["items.qty", 2] } }, /\$pow/],
        [{ sum: { $subtract: ["items.qty", 1, 2] } }, /\$subtract takes exactly 2/],
        [{ sum: { $multiply: ["items.qty"] } }, /\$multiply takes 2 to 10/],
        [{ sum: { $multiply: range(11).map(() => 1) } }, /\$multiply takes 2 to 10/],
        [{ sum: { $multiply: ["items.qty", true] } }, /operand/],
        [{ sum: { $multiply: ["items.qty bad", 2] } }, /Invalid field name/],
        [{ first: { $multiply: ["items.qty", 2] } }, /sum, avg, min and max/],
        [{ sum: { $size: 3 } }, /\$size takes a field/],
        [{ sum: { $multiply: ["items.qty", 2], $add: [1, 2] } }, /one/],
      ];
      for (const [spec, re] of bad) {
        await expect(query(slug, { aggregate: { x: spec } as never }), JSON.stringify(spec)).rejects.toThrow(re);
      }
      await expect(query(slug, { filter: { "items.sku": { $size: 3 } } })).rejects.toThrow(/\$size.*array of objects/);
    });
  });
});
