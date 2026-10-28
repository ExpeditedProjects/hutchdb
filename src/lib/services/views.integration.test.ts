import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Views service against real Postgres: the per-view `published` flag,
// group_by limited to kanban, updateView / deleteView / listViews with their
// access rules, and the 0023 backfill.
//
// Auto-skipped unless HUTCH_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.HUTCH_TEST_DATABASE_URL;
const OWNER_ID = "views-owner";
const VIEWER_ID = "views-viewer";
const ORG_ID = "views-org";
const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

type ViewsService = typeof import("@/lib/services/views");
type CollectionsService = typeof import("@/lib/services/collections");
type View = typeof schema.views.$inferSelect;

describe.skipIf(!TEST_DB_URL)("views service, real Postgres", () => {
  let testPool: Pool;
  let testDb: NodePgDatabase<typeof schema>;
  let appPool: Pool | undefined;
  let viewsSvc: ViewsService;
  let collectionsSvc: CollectionsService;
  const savedUrl = process.env.HUTCH_DATABASE_URL;

  beforeAll(async () => {
    process.env.HUTCH_DATABASE_URL = TEST_DB_URL;
    testPool = new Pool({ connectionString: TEST_DB_URL });
    testDb = drizzle(testPool, { schema });
    await migrate(testDb, { migrationsFolder: MIGRATIONS });
    viewsSvc = await import("@/lib/services/views");
    collectionsSvc = await import("@/lib/services/collections");
    appPool = (await import("@/lib/db")).db.$client as Pool;
    await testDb.insert(schema.user).values([
      { id: OWNER_ID, email: "views-owner@hutch.test", name: "Owner" },
      { id: VIEWER_ID, email: "views-viewer@hutch.test", name: "Viewer" },
    ]).onConflictDoNothing();
    await testDb.insert(schema.organizations).values({ id: ORG_ID, slug: "views-org", name: "Views", personal: true }).onConflictDoNothing();
    await testDb.insert(schema.organizationMembers).values({ organizationId: ORG_ID, userId: OWNER_ID, role: "admin" }).onConflictDoNothing();
  });

  beforeEach(async () => {
    await testDb.execute(sql`TRUNCATE collections RESTART IDENTITY CASCADE`);
    const tables = await testDb.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hc\_%'`);
    for (const row of tables.rows as { tablename: string }[]) {
      await testDb.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(row.tablename)} CASCADE`);
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await testPool?.end();
    if (savedUrl === undefined) delete process.env.HUTCH_DATABASE_URL;
    else process.env.HUTCH_DATABASE_URL = savedUrl;
  });

  async function makeCollection(name: string, published = false): Promise<{ id: number; slug: string }> {
    const { collection } = await collectionsSvc.createCollection(OWNER_ID, ORG_ID, { name, published });
    return { id: collection.id, slug: collection.slug };
  }

  async function makeView(slug: string, params: Parameters<ViewsService["createView"]>[2] = {}): Promise<View> {
    const result = await viewsSvc.createView(slug, OWNER_ID, params);
    if (!result || "error" in result) throw new Error(`createView failed: ${JSON.stringify(result)}`);
    return result.view as View;
  }

  async function grantViewer(collectionId: number) {
    await testDb.insert(schema.collectionMembers).values({ collectionId, userId: VIEWER_ID, role: "viewer" });
  }

  async function rawView(id: number): Promise<View> {
    const [row] = await testDb.select().from(schema.views).where(eq(schema.views.id, id));
    return row;
  }

  describe("createView", () => {
    it("creates views unpublished by default", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table" });
      expect(view.published).toBe(false);
      expect((await rawView(view.id)).published).toBe(false);
    });

    it("creates a published view when asked", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true });
      expect(view.published).toBe(true);
      expect((await rawView(view.id)).published).toBe(true);
    });

    it("rejects group_by on a non-kanban view and stores nothing", async () => {
      const { slug } = await makeCollection("Tasks");
      const result = await viewsSvc.createView(slug, OWNER_ID, { type: "table", groupBy: "status" });
      expect(result).toEqual({ error: "group_by applies to kanban views only", status: 400 });
      expect(await testDb.select().from(schema.views)).toHaveLength(0);
    });

    it("still stores group_by on kanban as config.groupByField", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "kanban", groupBy: "status" });
      expect(view.config).toEqual(expect.objectContaining({ groupByField: "status" }));
    });

    it("leaves seeded views unpublished", async () => {
      const { collection } = await collectionsSvc.createCollection(OWNER_ID, ORG_ID, {
        name: "Seeded",
        published: true,
        schema: { fields: [{ name: "status", type: "select", options: ["a", "b"] }, { name: "due", type: "date" }] },
      });
      const rows = await testDb.select().from(schema.views).where(eq(schema.views.collectionId, collection.id));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.published === false)).toBe(true);
    });
  });

  describe("updateView", () => {
    it("updates a view addressed by id", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", name: "All" });
      const before = (await rawView(view.id)).updatedAt!;

      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, {
        name: "  Open tasks  ",
        columns: ["title", "status"],
        sort: "-created_at",
        filter: { status: "open" },
        published: true,
      });

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("error");
      const updated = (result as { view: View }).view;
      expect(updated).toEqual(expect.objectContaining({
        id: view.id,
        name: "Open tasks",
        columns: ["title", "status"],
        sort: "-created_at",
        filter: { status: "open" },
        published: true,
      }));
      const row = await rawView(view.id);
      expect(row.published).toBe(true);
      expect(row.name).toBe("Open tasks");
      expect(row.updatedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("updates a view addressed by its slug, accepting the collection's name", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", name: "All" });

      const result = await viewsSvc.updateView("Tasks", view.slug, OWNER_ID, { published: true });
      expect((result as { view: View }).view.published).toBe(true);
      expect((await rawView(view.id)).published).toBe(true);
    });

    it("clears sort with null and leaves untouched fields alone", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", sort: "title", columns: ["title"] });

      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, { sort: null });
      const updated = (result as { view: View }).view;
      expect(updated.sort).toBeNull();
      expect(updated.columns).toEqual(["title"]);
      expect(updated.published).toBe(false);
    });

    it("validates the name like renameView", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", name: "All" });
      const blank = await viewsSvc.updateView(slug, view.id, OWNER_ID, { name: "   " });
      expect(blank).toEqual(expect.objectContaining({ status: 400 }));
      const long = await viewsSvc.updateView(slug, view.id, OWNER_ID, { name: "x".repeat(101) });
      expect(long).toEqual(expect.objectContaining({ status: 400 }));
      expect((await rawView(view.id)).name).toBe("All");
    });

    it("rejects group_by on a non-kanban view", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table" });
      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, { groupBy: "status" });
      expect(result).toEqual({ error: "group_by applies to kanban views only", status: 400 });
      expect((await rawView(view.id)).config).toEqual({});
    });

    it("on kanban, group_by sets config.groupByField and removes config.groupField", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "kanban", groupBy: "status" });
      // The Cloud dashboard writes groupField, which readers prefer.
      await viewsSvc.updateViewConfig(slug, view.id, OWNER_ID, { groupField: "status", cardTitle: "title" });

      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, { groupBy: "priority" });
      const config = (result as { view: View }).view.config as Record<string, unknown>;
      expect(config.groupByField).toBe("priority");
      expect(config).not.toHaveProperty("groupField");
      expect(config.cardTitle).toBe("title");
      expect((await rawView(view.id)).config).toEqual({ groupByField: "priority", cardTitle: "title" });
    });

    it("merges config through the allowlist", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "calendar", config: { dateField: "due" } });

      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, {
        config: { cardTitle: "title", evil: "<script>", imageField: "x".repeat(201) },
      });
      const config = (result as { view: View }).view.config as Record<string, unknown>;
      expect(config).toEqual({ dateField: "due", cardTitle: "title" });
    });

    it("does not reach a view of another collection", async () => {
      const a = await makeCollection("Alpha");
      const b = await makeCollection("Beta");
      const viewB = await makeView(b.slug, { type: "table", name: "Beta view" });

      expect(await viewsSvc.updateView(a.slug, viewB.id, OWNER_ID, { published: true })).toBeNull();
      expect(await viewsSvc.updateView(a.slug, viewB.slug, OWNER_ID, { published: true })).toBeNull();
      expect((await rawView(viewB.id)).published).toBe(false);
    });

    it("returns null for an unknown collection or view", async () => {
      const { slug } = await makeCollection("Tasks");
      expect(await viewsSvc.updateView("nope", 1, OWNER_ID, { published: true })).toBeNull();
      expect(await viewsSvc.updateView(slug, 9999, OWNER_ID, { published: true })).toBeNull();
      expect(await viewsSvc.updateView(slug, "no-such-view", OWNER_ID, { published: true })).toBeNull();
    });

    it("is refused to a viewer", async () => {
      const { id, slug } = await makeCollection("Tasks");
      await grantViewer(id);
      const view = await makeView(slug, { type: "table" });
      expect(await viewsSvc.updateView(slug, view.id, VIEWER_ID, { published: true })).toBeNull();
      expect((await rawView(view.id)).published).toBe(false);
    });
  });

  describe("deleteView", () => {
    it("deletes a view by id or slug", async () => {
      const { slug } = await makeCollection("Tasks");
      const one = await makeView(slug, { type: "table", name: "One" });
      const two = await makeView(slug, { type: "table", name: "Two" });

      expect(await viewsSvc.deleteView(slug, one.id, OWNER_ID)).toEqual({ deleted: true });
      expect(await viewsSvc.deleteView(slug, two.slug, OWNER_ID)).toEqual({ deleted: true });
      expect(await testDb.select().from(schema.views)).toHaveLength(0);
    });

    it("does not delete a view of another collection", async () => {
      const a = await makeCollection("Alpha");
      const b = await makeCollection("Beta");
      const viewB = await makeView(b.slug, { type: "table" });
      expect(await viewsSvc.deleteView(a.slug, viewB.id, OWNER_ID)).toBeNull();
      expect(await rawView(viewB.id)).toBeDefined();
    });

    it("is refused to a viewer", async () => {
      const { id, slug } = await makeCollection("Tasks");
      await grantViewer(id);
      const view = await makeView(slug, { type: "table" });
      expect(await viewsSvc.deleteView(slug, view.id, VIEWER_ID)).toBeNull();
      expect(await rawView(view.id)).toBeDefined();
    });
  });

  describe("listViews", () => {
    it("lists the collection's views in id order, to a viewer too", async () => {
      const a = await makeCollection("Alpha");
      const b = await makeCollection("Beta");
      await grantViewer(a.id);
      const first = await makeView(a.slug, { type: "table", name: "First" });
      await makeView(b.slug, { type: "table", name: "Other" });
      const second = await makeView(a.slug, { type: "kanban", name: "Second", groupBy: "status", published: true });

      const owner = await viewsSvc.listViews(a.slug, OWNER_ID);
      expect(owner!.map((v) => v.id)).toEqual([first.id, second.id]);
      expect(owner![1].published).toBe(true);

      const viewer = await viewsSvc.listViews(a.slug, VIEWER_ID);
      expect(viewer!.map((v) => v.id)).toEqual([first.id, second.id]);
    });

    it("returns null for a collection the user cannot see", async () => {
      const { slug } = await makeCollection("Tasks");
      expect(await viewsSvc.listViews(slug, VIEWER_ID)).toBeNull();
      expect(await viewsSvc.listViews("nope", OWNER_ID)).toBeNull();
    });
  });

  describe("migration 0023 backfill", () => {
    // There is no harness for running one migration against an older schema,
    // so this replays the migration's UPDATE against current rows.
    it("publishes every view of an already-published collection, and only those", async () => {
      const live = await makeCollection("Live", true);
      const draft = await makeCollection("Draft", false);
      const liveView = await makeView(live.slug, { type: "table" });
      const draftView = await makeView(draft.slug, { type: "table" });

      const file = readFileSync(`${MIGRATIONS}/0023_view_published.sql`, "utf8");
      const updates = file.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => /^UPDATE\b/i.test(s.replace(/^--.*$/gm, "").trim()));
      expect(updates).toHaveLength(1);
      await testDb.execute(sql.raw(updates[0]));

      expect((await rawView(liveView.id)).published).toBe(true);
      expect((await rawView(draftView.id)).published).toBe(false);
    });
  });
});
