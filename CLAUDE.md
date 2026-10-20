@AGENTS.md

# Hutch Core

Headless MCP server for structured agent data. Single-user, self-hosted. Next.js + Drizzle + Postgres.

The multi-user product (dashboard, published views, OAuth AS, org sharing) lives in the private Hutch Cloud repo. Do not add UI, OAuth, or multi-user features to Core.

## Development

```bash
npm run dev          # Start dev server on port 3111
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Run migrations
npm run smoke        # Hit /api/mcp against SMOKE_BASE_URL
npm run storage:cutover -- --dry-run   # Move an older database out of `records` (see Cutover below)
npm run storage:build-indexes [-- --collection <id|slug>]   # Build queued indexes/unwinds now (see Per-collection storage)
```

Core self-bootstraps its singleton user + personal org on the first authenticated request — no seed step.

## Architecture

- **MCP endpoint** at `/api/mcp` — bearer-auth via `HUTCH_API_KEY` (optional); anonymous singleton mode when unset.
- **REST seed** at `/api/v1/collections` (list only). Everything else goes through MCP.
- **Auth seam** at `src/lib/auth/seam.ts` — the only place auth lives.
- **Singleton bootstrap** at `src/lib/auth/singleton.ts` — lazy user + personal org insert.
- **DB schema** in `src/lib/db/schema.ts` — users, organizations, organization_members, collections, views (schema stays merge-compatible with Cloud; do not drop Cloud-only tables). There is no shared `records` table: each collection's rows live in its own table.
- **Per-collection storage** in `src/lib/storage/` — every collection's rows live in its own table `hc_<id>`, created in the same transaction as the collection (`ddl.ts`, `rows.ts`). As data arrives, `inference.ts`/`apply.ts` decide projections for common scalar fields (top-level and nested object paths; text over 2000 bytes projects to NULL), unwinds of large arrays of objects into child tables `hc_<id>__<path>` (kept in sync by triggers), and a full-text GIN once the table passes `HUTCH_SEARCH_INDEX_THRESHOLD_BYTES` (10 MB). The write only records each decision in `collections.storage` (`registry.ts`) as `pending`; it runs no DDL. `builder.ts` builds them outside the request — projections as expression indexes over the guarded cast (`expression.ts`, no columns, `CREATE INDEX CONCURRENTLY`), child tables with a batched backfill — under a per-collection advisory lock, moving each entry pending → building → ready | failed (generic reason, growing backoff; `HUTCH_INDEX_BUILD_TIMEOUT_MS`, default 10 min). The MCP route runs it after the response via `after()` (`build-queue.ts`, one builder per process, `HUTCH_INDEX_BUILD_CONCURRENCY`) for any collection a request touched with due work; `npm run storage:build-indexes` runs it by hand. Builds in `after()` stop at `HUTCH_AFTER_BUILD_BUDGET_MS` (default 240 s on Vercel, else no limit beyond the build timeout); a build that needs longer fails with a reason telling the operator to run the CLI, and a build the platform killed counts as a failed attempt and backs off. The compiler only uses ready entries (`readQueryRegistry`). Projections created before background builds are stored generated columns (no `kind`/`build` in the registry) and keep working as they are. The SQL helpers are in migrations `0021` and `0022`.
- **Query engine** in `src/lib/storage/compiler.ts` — compiles filter/search/sort/group_by/aggregate for one collection table, using projection columns and child tables only where they give the same answer as the JSONB document, and reports `indexed`/`plan`. Filter operator definitions live in `src/lib/db/queries.ts`; collection name-or-slug lookup in `src/lib/services/resolve.ts`.
- **Cutover** `npm run storage:cutover -- [--dry-run] [--drop-records] [--dump-dir <dir>]` moves a database created before per-collection storage out of the old shared `records` table: pg_dump first (refuses without it), copy and verify every collection in one transaction, then inference (which queues builds), then the builder runs every queued build before the script exits (a failed build is reported and exits 1). Re-runs skip finished collections and retry failed builds. `db:migrate` never touches `records`; only `--drop-records` drops it, after every collection has verified.

## Key Design Decisions

- Schema-optional: collections don't require schema definition
- Implicit collection creation: writing a record auto-creates the collection
- JSONB storage: records store arbitrary JSON, queryable via Postgres containment operators
- Upsert via unique_key: set on collection, then MCP `hutch_store_records` honors on_conflict

## Testing workflow

For new functionality (features, bug fixes that change behavior):

1. Dispatch a subagent to write failing tests against the agreed contract — no implementation.
2. Review the tests together before any code is written; the tests *are* the spec.
3. Implement to green. The test suite is the verification gate.

Test stack: vitest + @testing-library/react. Run `npm test` (vitest run) or `npm run test:watch`. Tests live next to source as `*.test.ts(x)`.

`*.integration.test.ts` run against real Postgres and are silently **skipped** unless `HUTCH_TEST_DATABASE_URL` is set (`createdb hutch_core_test` once, then `HUTCH_TEST_DATABASE_URL=postgresql://localhost/hutch_core_test npm test`). Any change to services, queries, or SQL should run them, and should usually add one: mocked unit tests only check SQL strings, and have missed real result-type bugs (numeric aggregates coming back as strings).

Changes to the shared Core surface get mirrored into Hutch Cloud (`../hutch-cloud`), whose CI `parity` job compares against this repo's `main`. Merge the Core PR first.

Skip TDD for trivial edits (renames, copy changes, removing dead code).

## Never

- Never restart Rails (this is a Next.js project)
- Never modify the auth seam (`src/lib/auth/seam.ts`) or singleton bootstrap without discussion
- Never re-add the dashboard, OAuth authorization server, or multi-user sharing to Core — those belong in Hutch Cloud
