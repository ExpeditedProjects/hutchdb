# Changelog

## 2026-10-23: Docker build requires a patched Node

Node before 26.12.1 has a Brotli decoder bug that allows remote code execution (CVE-2026-111497). The `Dockerfile` still uses the moving `node:26-alpine` tag, but the build now fails if the base image has an older Node, which happens when Docker reuses a cached base layer. If you self-host with Docker, rebuild with `docker compose build --pull` and restart.

## 2026-07-02 — Repositioning: Hutch Core is now a headless MCP server

Hutch Core has been narrowed to a single job: be the simplest self-hostable MCP server for structured agent data. Everything user-facing moved out.

**Removed from Core**

- Web dashboard (`/dashboard/**`, collection browser, record grid, view editor) and all supporting React components.
- Published views (`/p/[slug]`, submission forms, `/api/p/**`).
- OAuth 2.1 authorization server (`/api/oauth/**`, `/.well-known/oauth-*`, `src/lib/oauth-provider.ts`).
- Legacy session-cookie auth, login/logout routes, `src/lib/auth.ts`, and the old `authenticateMcpRequest` helper.
- Multi-user sharing: collection members, invitations, collection-level sharing MCP tools.
- Multi-user organizations: organization admin surface, invitations, and org-level MCP tools.
- Cross-org `transfer_collection` MCP tool.
- Email delivery module (`src/lib/email.ts`) — nothing left in Core sends mail.
- `scripts/seed.ts` / `npm run db:seed` and `scripts/docker-seed.js` — Core self-bootstraps its singleton user + personal org on first request.

**Kept in Core**

- MCP endpoint at `/api/mcp` with the data-tool surface: collections, records (store/query/search/update/delete/status/transform), schema (describe/infer/update), and views.
- REST seed at `/api/v1/collections` (list only) — an escape hatch for scripting.
- Auth seam (`src/lib/auth/seam.ts`) — optional `HUTCH_API_KEY` bearer, otherwise the anonymous singleton.
- Singleton bootstrap (`src/lib/auth/singleton.ts`) — one user, one personal org, inserted lazily.
- Postgres schema — tables that Cloud depends on (`users`, `organizations`, `organization_members`, `organization_invitations`, `collection_members`, `collection_invitations`) stay so migrations remain merge-compatible with Cloud.

**Where the removed features went**

Everything above is available at [Hutch Cloud](https://app.hutchdb.com). See the README's "What moved to Hutch Cloud" section. Note that claude.ai (the web app) requires OAuth, so it needs Cloud or a BYO-OAuth layer in front of Core.
