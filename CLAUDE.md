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
```

Core self-bootstraps its singleton user + personal org on the first authenticated request — no seed step.

## Architecture

- **MCP endpoint** at `/api/mcp` — bearer-auth via `HUTCH_API_KEY` (optional); anonymous singleton mode when unset.
- **REST seed** at `/api/v1/collections` (list only). Everything else goes through MCP.
- **Auth seam** at `src/lib/auth/seam.ts` — the only place auth lives.
- **Singleton bootstrap** at `src/lib/auth/singleton.ts` — lazy user + personal org insert.
- **DB schema** in `src/lib/db/schema.ts` — users, organizations, organization_members, collections, records, views (schema stays merge-compatible with Cloud; do not drop Cloud-only tables).
- **Query engine** in `src/lib/db/queries.ts` — JSONB containment, full-text search, aggregation.

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
