import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Views service against real Postgres: the per-view `published` flag, the
// columns a published view needs, owner-only publishing, the row lock,
// group_by limited to kanban, updateView / deleteView / listViews with their
// access rules, and the 0023 and 0024 migrations.
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

/** The saved schema makeCollection gives every collection: `secret` is hidden. */
const SAVED_SCHEMA = {
  fields: ["title", "status", "priority", "due", "cover", "secret"].map((name, position) => ({
    name,
    type: ({ status: "select", priority: "select", due: "date", cover: "image_url" } as Record<string, string>)[name] ?? "text",
    inferred: true,
    position,
    hidden: name === "secret",
  })),
  version: 1,
  lastInferredAt: "2026-11-12T00:00:00.000Z",
};
const VALID_FIELDS = "Valid fields: title, status, priority, due, cover.";

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

  /** A collection with SAVED_SCHEMA, set directly so no default views are seeded. */
  async function makeCollection(name: string, savedSchema: unknown = SAVED_SCHEMA): Promise<{ id: number; slug: string }> {
    const { collection } = await collectionsSvc.createCollection(OWNER_ID, ORG_ID, { name });
    await testDb.update(schema.collections).set({ schema: savedSchema }).where(eq(schema.collections.id, collection.id));
    return { id: collection.id, slug: collection.slug };
  }

  async function makeView(slug: string, params: Parameters<ViewsService["createView"]>[2] = {}): Promise<View> {
    const result = await viewsSvc.createView(slug, OWNER_ID, params);
    if (!result || "error" in result) throw new Error(`createView failed: ${JSON.stringify(result)}`);
    return result.view as View;
  }

  async function grantViewer(collectionId: number, role: "viewer" | "editor" = "viewer") {
    await testDb.insert(schema.collectionMembers).values({ collectionId, userId: VIEWER_ID, role });
  }

  async function ageView(id: number) {
    await testDb.update(schema.views).set({ updatedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(schema.views.id, id));
  }

  async function rawView(id: number): Promise<View> {
    const [row] = await testDb.select().from(schema.views).where(eq(schema.views.id, id));
    return row;
  }

  /** Waits until some query in this database is waiting on a lock. */
  async function waitForLockWait() {
    for (let i = 0; i < 250; i++) {
      const { rows } = await testPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      if (rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("no query waited for the row lock");
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
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
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

    it("stores only allowlisted config keys", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "calendar", config: { dateField: "due", evil: "<script>" } });
      expect((await rawView(view.id)).config).toEqual({ dateField: "due" });
    });

    it("leaves seeded views unpublished", async () => {
      const { collection } = await collectionsSvc.createCollection(OWNER_ID, ORG_ID, {
        name: "Seeded",
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
      await ageView(view.id);

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
      expect(row.updatedAt!.getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());
    });

    it("updates a view addressed by its slug, accepting the collection's name", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", name: "All" });

      const result = await viewsSvc.updateView("Tasks", view.slug, OWNER_ID, { published: true, columns: ["title"] });
      expect((result as { view: View }).view.published).toBe(true);
      expect((await rawView(view.id)).published).toBe(true);
    });

    it("replaces the filter rather than merging it", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", filter: { status: "open" } });
      await viewsSvc.updateView(slug, view.id, OWNER_ID, { filter: { priority: "high" } });
      expect((await rawView(view.id)).filter).toEqual({ priority: "high" });
    });

    it("unpublishes a published view", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: false });
      expect((await rawView(view.id)).published).toBe(false);
    });

    it("writes nothing when the patch is empty", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table" });
      await ageView(view.id);
      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, {});
      expect((result as { view: View }).view.id).toBe(view.id);
      expect((await rawView(view.id)).updatedAt).toEqual(new Date("2020-01-01T00:00:00Z"));
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

    it("treats a group field passed in config like group_by", async () => {
      const { slug } = await makeCollection("Tasks");
      const board = await makeView(slug, { type: "kanban", groupBy: "status" });
      await viewsSvc.updateViewConfig(slug, board.id, OWNER_ID, { groupField: "status" });

      await viewsSvc.updateView(slug, board.id, OWNER_ID, { config: { groupByField: "priority" } });
      expect((await rawView(board.id)).config).toEqual({ groupByField: "priority" });

      const table = await makeView(slug, { type: "table" });
      const rejected = await viewsSvc.updateView(slug, table.id, OWNER_ID, { config: { groupField: "status" } });
      expect(rejected).toEqual({ error: "group_by applies to kanban views only", status: 400 });
      expect((await rawView(table.id)).config).toEqual({});
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

    it("is allowed to an editor on a view that is not published", async () => {
      const { id, slug } = await makeCollection("Tasks");
      await grantViewer(id, "editor");
      const view = await makeView(slug, { type: "table" });
      expect(await viewsSvc.updateView(slug, view.id, VIEWER_ID, { name: "Editor's", columns: ["title"] })).not.toBeNull();
      expect(await rawView(view.id)).toEqual(expect.objectContaining({ name: "Editor's", columns: ["title"], published: false }));
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

    it("is allowed to an editor", async () => {
      const { id, slug } = await makeCollection("Tasks");
      await grantViewer(id, "editor");
      const view = await makeView(slug, { type: "table" });
      expect(await viewsSvc.deleteView(slug, view.id, VIEWER_ID)).toEqual({ deleted: true });
      expect(await rawView(view.id)).toBeUndefined();
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
      const second = await makeView(a.slug, { type: "kanban", name: "Second", groupBy: "status", published: true, columns: ["title", "status"] });

      const owner = await viewsSvc.listViews(a.slug, OWNER_ID);
      expect(owner!.map((v) => v.id)).toEqual([first.id, second.id]);
      expect(owner![1].published).toBe(true);

      const viewer = await viewsSvc.listViews(a.slug, VIEWER_ID);
      expect(viewer!.map((v) => v.id)).toEqual([first.id, second.id]);
      expect(Object.keys(viewer![0]).sort()).toEqual(
        ["columns", "config", "filter", "id", "name", "published", "slug", "sort", "type"],
      );
    });

    it("returns null for a collection the user cannot see", async () => {
      const { slug } = await makeCollection("Tasks");
      expect(await viewsSvc.listViews(slug, VIEWER_ID)).toBeNull();
      expect(await viewsSvc.listViews("nope", OWNER_ID)).toBeNull();
    });
  });

  describe("publishing needs picked columns", () => {
    it("refuses to create a published view without columns, listing the valid fields", async () => {
      const { slug } = await makeCollection("Tasks");
      const result = await viewsSvc.createView(slug, OWNER_ID, { type: "table", published: true });
      expect(result).toEqual({
        error: `Set columns before publishing: a published view shows only the fields listed in its columns. ${VALID_FIELDS}`,
        status: 400,
        code: "invalid_columns",
      });
      expect(await testDb.select().from(schema.views)).toHaveLength(0);
    });

    it("refuses hidden and unknown columns, naming them", async () => {
      const { slug } = await makeCollection("Tasks");
      const result = await viewsSvc.createView(slug, OWNER_ID, { type: "table", published: true, columns: ["title", "secret", "nope"] });
      expect(result).toEqual({
        error: `These columns are hidden or not in the collection's saved schema, so they cannot be published: secret, nope. ${VALID_FIELDS}`,
        status: 400,
        code: "invalid_columns",
      });
      expect(await testDb.select().from(schema.views)).toHaveLength(0);
    });

    it("says when the collection has no saved schema fields yet", async () => {
      const { slug } = await makeCollection("Tasks", { fields: [] });
      const result = await viewsSvc.createView(slug, OWNER_ID, { type: "table", published: true, columns: ["title"] });
      expect(result).toEqual(expect.objectContaining({ status: 400, code: "no_publishable_fields", error: expect.stringMatching(/^This collection has no saved schema fields yet/) }));
      expect(await testDb.select().from(schema.views)).toHaveLength(0);
    });

    it("publishes distinct visible columns, by create or by update", async () => {
      const { slug } = await makeCollection("Tasks");
      const created = await makeView(slug, { type: "table", published: true, columns: ["due", "title"] });
      expect(await rawView(created.id)).toEqual(expect.objectContaining({ published: true, columns: ["due", "title"] }));

      const draft = await makeView(slug, { type: "table" });
      const result = await viewsSvc.updateView(slug, draft.id, OWNER_ID, { published: true, columns: ["status"] });
      expect(result).not.toHaveProperty("error");
      expect(await rawView(draft.id)).toEqual(expect.objectContaining({ published: true, columns: ["status"] }));
    });

    it("refuses to publish a view whose stored columns are empty or not all strings, leaving it unchanged", async () => {
      const { slug } = await makeCollection("Tasks");
      const empty = await makeView(slug, { type: "table" });
      const mixed = await makeView(slug, { type: "table" });
      await testDb.update(schema.views).set({ columns: ["title", 5, { a: 1 }] }).where(eq(schema.views.id, mixed.id));
      for (const view of [empty, mixed]) {
        const before = await rawView(view.id);
        const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: true });
        expect(result).toEqual(expect.objectContaining({ status: 400, code: "invalid_columns" }));
        expect(await rawView(view.id)).toEqual(before);
      }
      expect((await viewsSvc.updateView(slug, mixed.id, OWNER_ID, { published: true }) as { error: string }).error)
        .toContain('cannot be published: 5, {"a":1}.');
    });

    it("refuses duplicate columns and more than 500, leaving the view unchanged", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      const before = await rawView(view.id);
      expect(await viewsSvc.updateView(slug, view.id, OWNER_ID, { columns: ["title", "due", "title"] })).toEqual({
        error: "These columns are listed more than once: title. List each field once.",
        status: 400,
      });
      const tooMany = Array.from({ length: viewsSvc.MAX_PUBLISHED_COLUMNS + 1 }, () => "title");
      expect(await viewsSvc.updateView(slug, view.id, OWNER_ID, { columns: tooMany })).toEqual({
        error: "A published view can have at most 500 columns; this one has 501.",
        status: 400,
      });
      expect(await viewsSvc.createView(slug, OWNER_ID, { type: "table", published: true, columns: ["due", "due"] })).toEqual(expect.objectContaining({ status: 400 }));
      expect(await rawView(view.id)).toEqual(before);
      expect(await testDb.select().from(schema.views)).toHaveLength(1);
    });

    it("refuses to clear or break the columns of a published view, but not when unpublishing it too", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      const before = await rawView(view.id);

      const cleared = await viewsSvc.updateView(slug, view.id, OWNER_ID, { columns: [] });
      expect(cleared).toEqual(expect.objectContaining({ status: 400, error: expect.stringMatching(/^Set columns before publishing/) }));
      const hidden = await viewsSvc.updateView(slug, view.id, OWNER_ID, { columns: ["title", "secret"] });
      expect(hidden).toEqual(expect.objectContaining({ status: 400, error: expect.stringContaining("cannot be published: secret.") }));
      expect(await rawView(view.id)).toEqual(before);

      await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: false, columns: [] });
      expect(await rawView(view.id)).toEqual(expect.objectContaining({ published: false, columns: [] }));
    });

    it("checks a published view's columns again when its config changes", async () => {
      const { id, slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true, columns: ["title", "due"] });
      // The owner hides a field after publishing.
      const hiddenDue = { ...SAVED_SCHEMA, fields: SAVED_SCHEMA.fields.map((f) => (f.name === "due" ? { ...f, hidden: true } : f)) };
      await testDb.update(schema.collections).set({ schema: hiddenDue }).where(eq(schema.collections.id, id));
      const before = await rawView(view.id);
      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, { config: { cardTitle: "title" } });
      expect(result).toEqual(expect.objectContaining({ status: 400, error: expect.stringContaining("cannot be published: due.") }));
      expect(await rawView(view.id)).toEqual(before);
    });
  });

  describe("the layout field must be one of the columns", () => {
    it.each([
      ["kanban", { groupBy: "status" }, 'groups by "status"', "status"],
      ["calendar", { config: { dateField: "due" } }, 'places records by the date in "due"', "due"],
      ["timeline", { config: { dateField: "due" } }, 'places records by the date in "due"', "due"],
      ["gallery", { config: { imageField: "cover" } }, 'shows the images in "cover"', "cover"],
    ])("for a %s view, by create and by update", async (type, extra, uses, field) => {
      const { slug } = await makeCollection("Tasks");
      const message = { error: `This ${type} view ${uses}, so "${field}" must be one of its columns before it can be published.`, status: 400 };
      expect(await viewsSvc.createView(slug, OWNER_ID, { type, published: true, columns: ["title"], ...extra })).toEqual(message);
      expect(await testDb.select().from(schema.views)).toHaveLength(0);

      const draft = await makeView(slug, { type, columns: ["title"], ...extra });
      const before = await rawView(draft.id);
      expect(await viewsSvc.updateView(slug, draft.id, OWNER_ID, { published: true })).toEqual(message);
      expect(await rawView(draft.id)).toEqual(before);

      await viewsSvc.updateView(slug, draft.id, OWNER_ID, { published: true, columns: ["title", field] });
      expect(await rawView(draft.id)).toEqual(expect.objectContaining({ published: true, columns: ["title", field] }));
    });

    it("lets a published kanban regroup to a field among its columns, and refuses any other", async () => {
      const { slug } = await makeCollection("Tasks");
      const board = await makeView(slug, { type: "kanban", groupBy: "status", published: true, columns: ["title", "status", "priority"] });
      const before = await rawView(board.id);
      expect(await viewsSvc.updateView(slug, board.id, OWNER_ID, { groupBy: "due" })).toEqual({
        error: 'This kanban view groups by "due", so "due" must be one of its columns before it can be published.',
        status: 400,
      });
      expect(await rawView(board.id)).toEqual(before);

      await viewsSvc.updateView(slug, board.id, OWNER_ID, { groupBy: "priority" });
      expect(await rawView(board.id)).toEqual(expect.objectContaining({ config: { groupByField: "priority" }, columns: ["title", "status", "priority"] }));
    });

    it("applies to the dashboard's groupField through updateViewConfig, which readers prefer", async () => {
      const { slug } = await makeCollection("Tasks");
      const board = await makeView(slug, { type: "kanban", groupBy: "status", published: true, columns: ["title", "status"] });
      const before = await rawView(board.id);
      expect(await viewsSvc.updateViewConfig(slug, board.id, OWNER_ID, { groupField: "priority" })).toEqual({
        error: 'This kanban view groups by "priority", so "priority" must be one of its columns before it can be published.',
        status: 400,
      });
      expect(await rawView(board.id)).toEqual(before);
      await viewsSvc.updateViewConfig(slug, board.id, OWNER_ID, { cardTitle: "title" });
      expect((await rawView(board.id)).config).toEqual({ groupByField: "status", cardTitle: "title" });
    });

    it("lets a view be unpublished and regrouped in one call", async () => {
      const { slug } = await makeCollection("Tasks");
      const board = await makeView(slug, { type: "kanban", groupBy: "status", published: true, columns: ["title", "status"] });
      const result = await viewsSvc.updateView(slug, board.id, OWNER_ID, { published: false, groupBy: "due" });
      expect(result).not.toHaveProperty("error");
      expect(await rawView(board.id)).toEqual(expect.objectContaining({ published: false, config: { groupByField: "due" } }));
    });

    it.each(["secret", "nope"])("refuses a layout field that is hidden or unknown (%s)", async (field) => {
      const { slug } = await makeCollection("Tasks");
      expect(await viewsSvc.createView(slug, OWNER_ID, { type: "gallery", config: { imageField: field }, published: true, columns: ["title"] })).toEqual({
        error: `This gallery view shows the images in "${field}", which is hidden or not in the collection's saved schema, so the view cannot be published.`,
        status: 400,
        code: "invalid_columns",
      });
      expect(await testDb.select().from(schema.views)).toHaveLength(0);
    });

    it("drops a stale dashboard groupField when created with group_by", async () => {
      const { slug } = await makeCollection("Tasks");
      const board = await makeView(slug, { type: "kanban", groupBy: "status", config: { groupField: "priority" } });
      expect((await rawView(board.id)).config).toEqual({ groupByField: "status" });
    });

    it("infers a kanban grouping from the first visible select field, skipping hidden ones", async () => {
      const { slug } = await makeCollection("Tasks", {
        fields: [{ name: "secret", type: "select", hidden: true }, { name: "title", type: "text", hidden: false }, { name: "status", type: "select", hidden: false }],
      });
      const board = await makeView(slug, { type: "kanban", inferGroupBy: true });
      expect((await rawView(board.id)).config).toEqual({ groupByField: "status" });

      const { slug: bare } = await makeCollection("Bare", { fields: [{ name: "secret", type: "select", hidden: true }] });
      expect(await viewsSvc.createView(bare, OWNER_ID, { type: "kanban", inferGroupBy: true })).toEqual(expect.objectContaining({ status: 400, code: "no_group_field" }));
    });

    it("does not trip over a stored view type that names an Object.prototype key", async () => {
      const { slug } = await makeCollection("Tasks");
      for (const type of ["constructor", "__proto__"]) {
        const view = await makeView(slug, { type, columns: ["title"], config: { dateField: "nope" } });
        expect(await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: true })).not.toHaveProperty("error");
        expect(await viewsSvc.updateViewConfig(slug, view.id, OWNER_ID, { imageField: "nope" })).not.toHaveProperty("error");
        expect(await rawView(view.id)).toEqual(expect.objectContaining({ type, published: true, columns: ["title"] }));
      }
    });
  });

  describe("only the collection's owner publishes", () => {
    const OWNER_ONLY = { error: "Only the collection's owner can publish a view or change a published one.", status: 403, code: "owner_only" };

    async function editorCollection() {
      const made = await makeCollection("Tasks");
      await grantViewer(made.id, "editor");
      return made;
    }

    it("refuses an editor to create a published view", async () => {
      const { slug } = await editorCollection();
      expect(await viewsSvc.createView(slug, VIEWER_ID, { type: "table", published: true, columns: ["title"] })).toEqual(OWNER_ONLY);
      expect(await testDb.select().from(schema.views)).toHaveLength(0);
    });

    it("refuses an editor to publish a view, leaving it unchanged", async () => {
      const { slug } = await editorCollection();
      const view = await makeView(slug, { type: "table", columns: ["title"] });
      const before = await rawView(view.id);
      expect(await viewsSvc.updateView(slug, view.id, VIEWER_ID, { published: true })).toEqual(OWNER_ONLY);
      expect(await rawView(view.id)).toEqual(before);
    });

    it("refuses an editor every change to a published view, through each entry point", async () => {
      const { slug } = await editorCollection();
      const board = await makeView(slug, { type: "kanban", groupBy: "status", published: true, columns: ["title", "status", "priority"] });
      const before = await rawView(board.id);
      const attempts = [
        viewsSvc.updateView(slug, board.id, VIEWER_ID, { name: "Mine" }),
        viewsSvc.updateView(slug, board.id, VIEWER_ID, { filter: { status: "open" } }),
        viewsSvc.updateView(slug, board.id, VIEWER_ID, { sort: "-due" }),
        viewsSvc.updateView(slug, board.id, VIEWER_ID, { columns: ["title", "status"] }),
        viewsSvc.updateView(slug, board.id, VIEWER_ID, { config: { cardTitle: "title" } }),
        viewsSvc.updateView(slug, board.id, VIEWER_ID, { groupBy: "priority" }),
        viewsSvc.updateView(slug, board.id, VIEWER_ID, { published: true }),
        viewsSvc.updateViewConfig(slug, board.id, VIEWER_ID, { groupField: "priority" }),
        viewsSvc.renameView(slug, board.id, VIEWER_ID, "Mine"),
      ];
      for (const attempt of attempts) expect(await attempt).toEqual(OWNER_ONLY);
      expect(await rawView(board.id)).toEqual(before);
    });

    it("lets an editor unpublish a published view, alone or with other changes", async () => {
      const { slug } = await editorCollection();
      const one = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      const two = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      expect(await viewsSvc.updateView(slug, one.id, VIEWER_ID, { published: false })).not.toHaveProperty("error");
      expect((await rawView(one.id)).published).toBe(false);
      expect(await viewsSvc.updateView(slug, two.id, VIEWER_ID, { published: false, name: "Private", columns: [] })).not.toHaveProperty("error");
      expect(await rawView(two.id)).toEqual(expect.objectContaining({ published: false, name: "Private", columns: [] }));
    });

    it("lets an editor change a view that is not published, through each entry point", async () => {
      const { slug } = await editorCollection();
      const view = await makeView(slug, { type: "calendar", columns: ["title"] });
      expect(await viewsSvc.updateView(slug, view.id, VIEWER_ID, { columns: ["anything"], sort: "title" })).not.toHaveProperty("error");
      expect(await viewsSvc.updateViewConfig(slug, view.id, VIEWER_ID, { dateField: "due" })).not.toHaveProperty("error");
      expect(await viewsSvc.renameView(slug, view.id, VIEWER_ID, "Editor's")).not.toHaveProperty("error");
      expect(await rawView(view.id)).toEqual(expect.objectContaining({ name: "Editor's", columns: ["anything"], sort: "title", config: { dateField: "due" }, published: false }));
    });

    it("lets the owner publish and change a published view", async () => {
      const { slug } = await editorCollection();
      const view = await makeView(slug, { type: "table", columns: ["title"] });
      expect(await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: true })).not.toHaveProperty("error");
      expect(await viewsSvc.renameView(slug, view.id, OWNER_ID, "Public")).not.toHaveProperty("error");
      expect(await viewsSvc.updateViewConfig(slug, view.id, OWNER_ID, { cardTitle: "title" })).not.toHaveProperty("error");
      expect(await rawView(view.id)).toEqual(expect.objectContaining({ name: "Public", published: true, columns: ["title"] }));
    });
  });

  describe("who published the view, and when", () => {
    async function publisherOf(id: number) {
      const row = await rawView(id);
      return { publishedBy: row.publishedBy, publishedAt: row.publishedAt };
    }

    it("is recorded when a view is created published, and not when created private", async () => {
      const { slug } = await makeCollection("Tasks");
      const before = Date.now();
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      const { publishedBy, publishedAt } = await publisherOf(view.id);
      expect(publishedBy).toBe(OWNER_ID);
      expect(publishedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(await publisherOf((await makeView(slug, { type: "table" })).id)).toEqual({ publishedBy: null, publishedAt: null });
    });

    it("is recorded when a private view is published later", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", columns: ["title"] });
      expect(await publisherOf(view.id)).toEqual({ publishedBy: null, publishedAt: null });
      const result = await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: true });
      expect(result).toEqual(expect.objectContaining({ view: expect.objectContaining({ publishedBy: OWNER_ID }) }));
      const { publishedBy, publishedAt } = await publisherOf(view.id);
      expect(publishedBy).toBe(OWNER_ID);
      expect(publishedAt).toBeInstanceOf(Date);
    });

    it("is cleared when the view is unpublished", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: false });
      expect(await publisherOf(view.id)).toEqual({ publishedBy: null, publishedAt: null });
    });

    it("is cleared when an editor unpublishes the owner's view", async () => {
      const made = await makeCollection("Tasks");
      await grantViewer(made.id, "editor");
      const view = await makeView(made.slug, { type: "table", published: true, columns: ["title"] });
      expect(await viewsSvc.updateView(made.slug, view.id, VIEWER_ID, { published: false })).not.toHaveProperty("error");
      expect(await publisherOf(view.id)).toEqual({ publishedBy: null, publishedAt: null });
    });

    it("is kept when a published view's name, columns, config, sort or filter change, through each entry point", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "kanban", groupBy: "status", published: true, columns: ["title", "status"] });
      const at = new Date("2026-01-02T03:04:05Z");
      await testDb.update(schema.views).set({ publishedAt: at }).where(eq(schema.views.id, view.id));
      for (const result of [
        await viewsSvc.updateView(slug, view.id, OWNER_ID, { name: "Board", columns: ["title", "status", "priority"], sort: "-due", filter: { status: "open" } }),
        await viewsSvc.updateView(slug, view.id, OWNER_ID, { groupBy: "priority" }),
        await viewsSvc.updateViewConfig(slug, view.id, OWNER_ID, { cardTitle: "title" }),
        await viewsSvc.renameView(slug, view.id, OWNER_ID, "Renamed"),
      ]) expect(result).not.toHaveProperty("error");
      expect(await rawView(view.id)).toEqual(expect.objectContaining({ name: "Renamed", published: true, publishedBy: OWNER_ID, publishedAt: at }));
    });

    it("is kept when an already published view is published again", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      const at = new Date("2026-01-02T03:04:05Z");
      await testDb.update(schema.views).set({ publishedAt: at }).where(eq(schema.views.id, view.id));
      expect(await viewsSvc.updateView(slug, view.id, OWNER_ID, { published: true, name: "Again" })).not.toHaveProperty("error");
      expect(await publisherOf(view.id)).toEqual({ publishedBy: OWNER_ID, publishedAt: at });
    });

    it("becomes NULL when the publisher's account is deleted", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", published: true, columns: ["title"] });
      await testDb.insert(schema.user).values({ id: "views-gone", email: "views-gone@hutch.test", name: "Gone" }).onConflictDoNothing();
      await testDb.update(schema.views).set({ publishedBy: "views-gone" }).where(eq(schema.views.id, view.id));
      await testDb.delete(schema.user).where(eq(schema.user.id, "views-gone"));
      expect((await rawView(view.id)).publishedBy).toBeNull();
      expect((await rawView(view.id)).published).toBe(true);
    });
  });

  describe("row lock", () => {
    // A publish that commits while a column change is in flight: the change
    // must see the published row, not the one it would have read before.
    it("re-reads the view after a concurrent publish commits, so its columns are still checked", async () => {
      const { slug } = await makeCollection("Tasks");
      const view = await makeView(slug, { type: "table", columns: ["title"] });
      const other = await testPool.connect();
      try {
        await other.query("BEGIN");
        await other.query("UPDATE views SET published = true WHERE id = $1", [view.id]);
        const pending = viewsSvc.updateView(slug, view.id, OWNER_ID, { columns: [] });
        await waitForLockWait();
        await other.query("COMMIT");
        expect(await pending).toEqual(expect.objectContaining({ status: 400, error: expect.stringMatching(/^Set columns before publishing/) }));
      } finally {
        other.release();
      }
      expect(await rawView(view.id)).toEqual(expect.objectContaining({ published: true, columns: ["title"] }));
    });
  });

  // There is no harness for running one migration against an older schema,
  // so these replay a migration's UPDATE against current rows.
  function migrationUpdate(tag: string): string {
    const file = readFileSync(`${MIGRATIONS}/${tag}.sql`, "utf8");
    const updates = file.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").trim()).filter((s) => /^UPDATE\b/i.test(s));
    expect(updates).toHaveLength(1);
    return updates[0];
  }

  describe("migration 0023 backfill", () => {
    it("publishes every view of an already-published collection, and only those", async () => {
      const live = await makeCollection("Live");
      const draft = await makeCollection("Draft");
      // collections.published is no longer settable through the services.
      await testDb.update(schema.collections).set({ published: true }).where(eq(schema.collections.id, live.id));
      const liveView = await makeView(live.slug, { type: "table" });
      const draftView = await makeView(draft.slug, { type: "table" });

      await testDb.execute(sql.raw(migrationUpdate("0023_view_published")));

      expect((await rawView(liveView.id)).published).toBe(true);
      expect((await rawView(draftView.id)).published).toBe(false);
    });
  });

  describe("migration 0024 unpublish", () => {
    it("unpublishes every view, leaving its columns and config alone", async () => {
      const a = await makeCollection("Alpha");
      const b = await makeCollection("Beta");
      const one = await makeView(a.slug, { type: "kanban", groupBy: "status", published: true, columns: ["title", "status"] });
      const two = await makeView(b.slug, { type: "table", published: true, columns: ["due"] });
      const draft = await makeView(b.slug, { type: "table" });
      await ageView(one.id);

      await testDb.execute(sql.raw(migrationUpdate("0024_unpublish_views")));

      const rows = await testDb.select().from(schema.views);
      expect(rows.map((r) => r.published)).toEqual([false, false, false]);
      expect(await rawView(one.id)).toEqual(expect.objectContaining({
        columns: ["title", "status"], config: { groupByField: "status" }, updatedAt: new Date("2020-01-01T00:00:00Z"),
      }));
      expect((await rawView(two.id)).columns).toEqual(["due"]);
      expect((await rawView(draft.id)).published).toBe(false);
    });
  });

  describe("migration 0025 backfill", () => {
    const TEAM_ORG_ID = "views-team-org";

    /** The migration's statements after its ALTERs: the UPDATE and the DO block. */
    function backfillStatements(): string[] {
      const file = readFileSync(`${MIGRATIONS}/0025_view_publisher.sql`, "utf8");
      const stmts = file.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").trim()).filter((s) => /^(UPDATE|DO)\b/i.test(s));
      expect(stmts).toHaveLength(2);
      return stmts;
    }

    it("credits published views of a personal org to its owner at their last change, and leaves team orgs and private views NULL", async () => {
      await testDb.insert(schema.organizations).values({ id: TEAM_ORG_ID, slug: "views-team", name: "Team" }).onConflictDoNothing();
      await testDb.insert(schema.organizationMembers).values({ organizationId: TEAM_ORG_ID, userId: OWNER_ID, role: "admin" }).onConflictDoNothing();
      const mine = await makeCollection("Mine");
      const team = await makeCollection("Team");
      await testDb.update(schema.collections).set({ organizationId: TEAM_ORG_ID }).where(eq(schema.collections.id, team.id));
      const views = {
        mine: await makeView(mine.slug, { type: "table", columns: ["title"] }),
        team: await makeView(team.slug, { type: "table", columns: ["title"] }),
        draft: await makeView(mine.slug, { type: "table" }),
      };
      // As they were before the migration: published, with no publisher yet.
      await testDb.update(schema.views).set({ published: true }).where(sql`${schema.views.id} IN (${views.mine.id}, ${views.team.id})`);
      await ageView(views.mine.id);
      await ageView(views.team.id);

      for (const stmt of backfillStatements()) await testDb.execute(sql.raw(stmt));

      const aged = new Date("2020-01-01T00:00:00Z");
      expect(await rawView(views.mine.id)).toEqual(expect.objectContaining({ publishedBy: OWNER_ID, publishedAt: aged, updatedAt: aged }));
      expect(await rawView(views.team.id)).toEqual(expect.objectContaining({ publishedBy: null, publishedAt: aged }));
      expect(await rawView(views.draft.id)).toEqual(expect.objectContaining({ publishedBy: null, publishedAt: null }));
    });
  });
});
