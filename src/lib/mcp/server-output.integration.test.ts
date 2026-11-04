import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Tool output against real Postgres carries the user's data, not storage
// bookkeeping: records leave out collectionId/source/deletedAt, views leave
// out collectionId, and collections leave out organizationId — while user
// data that happens to use those key names inside `data` is untouched.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const { tools } = vi.hoisted(() => ({ tools: new Map<string, (p: unknown) => Promise<unknown>>() }));
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, handler: (p: unknown) => Promise<unknown>) {
      tools.set(name, handler);
    }
  },
}));

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;
const USER_ID = "server-output-user";
const ORG_ID = "server-output-org";
const INTERNAL = ["collectionId", "source", "deletedAt", "organizationId"];

type ToolResult = { content: { text: string }[]; isError?: boolean };

/** The JSON part of a tool response (some lead with a summary line). */
function json(result: unknown): Record<string, unknown> {
  const r = result as ToolResult;
  expect(r.isError).toBeFalsy();
  const text = r.content[0].text;
  return JSON.parse(text.slice(text.indexOf("{")));
}

describe.skipIf(!TEST_DB_URL)("MCP tool output fields, real Postgres", () => {
  let testPool: Pool;
  let appPool: Pool | undefined;
  const savedUrl = process.env.HUTCH_DATABASE_URL;
  const call = (name: string, params: unknown) => tools.get(name)!(params);

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    const testDb = drizzle(testPool, { schema });
    await migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
    await testDb.insert(schema.user).values({ id: USER_ID, email: "server-output@hutch.test", name: "Output" }).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "server-output", name: "Output", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }).onConflictDoNothing();
    appPool = (await import("@/lib/db")).db.$client as Pool;
    const { createMcpServer } = await import("./server");
    createMcpServer(USER_ID, ORG_ID, "https://example.test");
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    if (savedUrl === undefined) delete process.env.HUTCH_DATABASE_URL;
    else process.env.HUTCH_DATABASE_URL = savedUrl;
  });

  function expectNoInternalKeys(obj: unknown) {
    for (const key of INTERNAL) expect(obj).not.toHaveProperty(key);
  }

  it("records, views and collections in every response leave out internal keys but keep user data", async () => {
    // User data that uses an internal key name must survive untouched.
    const stored = json(await call("hutch_store_records", {
      collection: "Output Notes",
      records: [{ title: "zebra crossing", source: "field notes", collectionId: "mine", deletedAt: "never" }, { title: "other" }],
    }));
    const slug = (stored.collection as { slug: string }).slug;
    const results = stored.results as { record: Record<string, unknown> }[];
    expect(results).toHaveLength(2);
    for (const r of results) {
      expectNoInternalKeys(r.record);
      expect(Object.keys(r.record).sort()).toEqual(["createdAt", "data", "id", "status", "updatedAt"]);
    }
    expect(results[0].record.data).toMatchObject({ source: "field notes", collectionId: "mine", deletedAt: "never" });

    const query = json(await call("hutch_query_records", { slug }));
    const records = query.records as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    records.forEach(expectNoInternalKeys);
    expect(records.some((r) => (r.data as Record<string, unknown>).source === "field notes")).toBe(true);

    const search = json(await call("hutch_search", { search: "zebra" }));
    const groups = search.results as { records: Record<string, unknown>[] }[];
    expect(groups.flatMap((g) => g.records)).toHaveLength(1);
    groups.flatMap((g) => g.records).forEach(expectNoInternalKeys);

    const id = records[0].id as number;
    const updated = json(await call("hutch_update_record", { slug, record_id: id, data: { title: "zebra 2" } }));
    expectNoInternalKeys(updated);
    expect(updated.data).toEqual({ title: "zebra 2" });

    const status = json(await call("hutch_set_record_status", { slug, record_id: id, status: "flagged" }));
    expectNoInternalKeys(status.record);
    expect((status.record as Record<string, unknown>).status).toBe("flagged");

    const view = json(await call("hutch_create_view", { slug, type: "table", name: "All" }));
    expectNoInternalKeys(view);
    const renamed = json(await call("hutch_update_view", { slug, view: view.id, name: "Everything" }));
    expectNoInternalKeys(renamed);
    expect(renamed.name).toBe("Everything");

    const coll = json(await call("hutch_get_collection", { slug }));
    expectNoInternalKeys(coll);
    expect(coll.slug).toBe(slug);
    (coll.views as unknown[]).forEach(expectNoInternalKeys);

    const updatedColl = json(await call("hutch_update_collection", { slug, description: "notes" }));
    expectNoInternalKeys(updatedColl);
    expect(updatedColl.description).toBe("notes");

    const imported = json(await call("hutch_import_records", { collection: slug, format: "csv", content: "title\nimported\n", return: "records" }));
    expect(imported.results).toHaveLength(1);
    for (const r of imported.results as { record: unknown }[]) expectNoInternalKeys(r.record);
  });

  it("a single-record store (data:) leaves out internal keys on its top-level record", async () => {
    const single = json(await call("hutch_store_records", { collection: "Output Single", data: { title: "x", source: "mine" } }));
    const record = single.record as Record<string, unknown>;
    expectNoInternalKeys(record);
    expect(record.data).toEqual({ title: "x", source: "mine" });
  });

  it("storing into a new collection seeds the default views its description promises", async () => {
    const stored = json(await call("hutch_store_records", {
      collection: "Output Tasks",
      records: [
        { title: "a", status: "open", due: "2026-01-01" },
        { title: "b", status: "done", due: "2026-02-01" },
      ],
    }));
    const slug = (stored.collection as { slug: string }).slug;
    const coll = json(await call("hutch_get_collection", { slug }));
    const types = (coll.views as { type: string }[]).map((v) => v.type).sort();
    expect(types).toEqual(["calendar", "kanban", "timeline"]);
  });

  it("a per-record group_by over an array attaches the parent record without internal keys", async () => {
    await call("hutch_store_records", {
      collection: "Output Orders",
      records: [
        { name: "first", source: "web", items: [{ sku: "a" }, { sku: "b" }] },
        { name: "second", items: [{ sku: "a" }] },
      ],
    });
    const agg = json(await call("hutch_query_records", { slug: "output-orders", group_by: "items.sku", aggregate: { n: "count" }, per_record: true }));
    const groups = agg.results as { record: Record<string, unknown> | null }[];
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.record).not.toBeNull();
      expectNoInternalKeys(g.record);
    }
    expect(groups.some((g) => (g.record!.data as Record<string, unknown>).source === "web")).toBe(true);
  });
});
