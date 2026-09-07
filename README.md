<!-- Banner slot: drop a Plex Terminal banner at assets/banner.png and swap this in:
<p align="center"><img src="assets/banner.png" alt="HutchDB" width="100%" style="border-radius: 8px;" /></p>
-->

<h1 align="center">HutchDB</h1>

<p align="center"><b>A database for AI agents. No schema, SQL, or structure required.</b><br />
A structured workspace that Claude Code, Codex, Cursor, Hermes, Claw, Grokbot, and other MCP clients can read and update together. Open source.</p>

<p align="center">
  <a href="https://hutchdb.com"><img src="https://img.shields.io/badge/Website-hutchdb.com-fbbf24" alt="Website" /></a>&nbsp;
  <a href="https://app.hutchdb.com"><img src="https://img.shields.io/badge/HutchDB-Cloud-fbbf24" alt="HutchDB Cloud" /></a>&nbsp;
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-blue" alt="MCP" /></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ExpeditedProjects/hutchdb" alt="License" /></a>
</p>

---

## What is HutchDB?

HutchDB Core is a **headless, single-user MCP server** that gives every agent you run the same durable, structured data. Connect Claude Code, Codex, Cursor, VS Code, or another MCP client and they can store, query, and update shared collections of records across sessions.

Collections use schema-optional Postgres JSONB with full-text search, optional validation, and view definitions. There is **no dashboard, no login screen, and no OAuth ceremony** — just an MCP endpoint and a Postgres database you control.

This repo is the OSS engine. If you want people and agents working from the same visual workspace, [HutchDB Cloud](https://app.hutchdb.com) adds web views, published pages, social login, and organization sharing. See [Core vs Cloud](#hutchdb-core-vs-hutchdb-cloud) below.

## What can you use it for?

The default home for agent working data is a markdown file: a `TODO.md`, a notes directory, a memory file full of prose. That works for one agent taking notes to itself. It breaks down the moment you want to filter ("open bugs above severity 2"), aggregate ("pipeline value by stage"), or have two agents update the same list without overwriting each other.

HutchDB holds the same information as real records: individually addressable, queryable, and safe for multiple agents to read and update at once. That makes it fit anywhere an agent produces or uses structured data that needs to outlast one chat. Some patterns people run on it:

**Research that accumulates.** Customer interviews, competitor teardowns, scraped listings, literature reviews. Each session adds records to a collection; any later session can query the whole set.

> "Save these five competitor pricing pages to `competitor-pricing`, then tell me who changed since last month."

**Trackers you'd otherwise keep in a spreadsheet.** Bug reports, content calendars, job applications, inventory, reading lists. The difference from a spreadsheet: your agents can query and update the records mid-task.

> "Log this bug to `bug-reports` with severity high, then list everything still open."

**Pipelines with handoffs between agents.** One agent collects records, another processes them, a third reports on the results. A status field on each record marks where it is in the pipeline, so nothing gets copied between tools.

> "Pull every `leads` record with status `new`, enrich each one, and set its status to `ready-for-outreach`."

**Working state for long-running projects.** Decisions, open questions, and backlog items stay queryable after the context window closes. A new session starts by asking what came before instead of being re-briefed.

> "What did we decide about the pricing page last week, and what's still unresolved?"

**Repeatable playbooks.** Store the instructions, inputs, and current status for recurring jobs (weekly reports, release checklists, content production) so any agent can pick one up and run it.

> "Run the weekly-metrics playbook and store the results in `weekly-reports`."

None of this needs schema design up front: collections auto-create on the first write and records are arbitrary JSON. Start with "save this to HutchDB," then query the same records from any connected agent.

## Quick Start

> **Note**: Full documentation lives at [hutchdb.com](https://hutchdb.com).

1. **Clone and boot** (Docker):

   ```bash
   git clone https://github.com/ExpeditedProjects/hutchdb
   cd hutchdb
   docker compose up
   ```

   Core migrates the database and boots on port 3000. The singleton user and personal org are inserted lazily on the first request — there is no seed step.

2. **Lock it down** (optional but recommended off-localhost) — require a bearer token on every MCP call by setting an API key before booting:

   ```bash
   export HUTCH_API_KEY="$(openssl rand -hex 32)"
   ```

   If unset, all requests are trusted — fine for localhost, not fine for a public host.

3. **Connect your agent.** For Claude Code, add to your MCP config:

   ```json
   {
     "mcpServers": {
       "hutch": {
         "type": "http",
         "url": "http://localhost:3000/api/mcp",
         "headers": {
           "Authorization": "Bearer YOUR_HUTCH_API_KEY"
         }
       }
     }
   }
   ```

   Cursor, Codex, and VS Code accept the same HTTP MCP server shape — same `url`, same bearer header.

4. **Use it.** Collections auto-create on first write — there is no setup step. Just talk to your agent:

   > "Save these launch tasks to HutchDB."
   > "What did we store about the pricing research last week?"
   > "Query the bug-reports collection for anything mentioning timeouts."

5. **Verify the endpoint** (optional):

   ```bash
   curl -X POST http://localhost:3000/api/mcp \
     -H "Authorization: Bearer $HUTCH_API_KEY" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```

   You should see the `hutch_*` tool list (collections, records, schema, views).

<details>
<summary><b>Running without Docker</b></summary>

```bash
git clone https://github.com/ExpeditedProjects/hutchdb
cd hutchdb
npm install
cp .env.local.example .env.local
# Required: HUTCH_DATABASE_URL
# Optional: HUTCH_API_KEY
npm run db:migrate
npm run dev
```

The dev MCP endpoint is `http://localhost:3111/api/mcp` (production/Docker: port 3000).

</details>

## Example

A typical session with Claude Code connected to a local Core instance:

```text
You:    Save each of these customer interviews as a record — tag the ones
        that mention pricing.

Agent:  Stored 9 records in `customer-interviews`, 4 tagged "pricing".

You:    (a week later) Which interviewees complained about onboarding?

Agent:  Querying `customer-interviews`... 3 records match: Dana R.,
        Marcus T., and the anonymous Feb 12 call.
```

Records are arbitrary JSON in Postgres JSONB — queryable via containment filters, Mongo-style operators (`$gt`, `$in`, `$exists`, `$contains`, …), and full-text search, with optional schemas when you want structure enforced. Collections export and import as CSV or JSON when data needs to move.

## HutchDB Core vs HutchDB Cloud

Core is intentionally small. If you want the product layer, run [HutchDB Cloud](https://app.hutchdb.com) — or fork Core and build your own.

| | Core (this repo) | [HutchDB Cloud](https://app.hutchdb.com) |
| --- | --- | --- |
| MCP server (collections, records, schema, views) | ✅ | ✅ |
| Self-hosted, single-user, static API key | ✅ | — |
| Web dashboard, record grid, view editor | — | ✅ |
| Published views + public pages | — | ✅ |
| OAuth 2.1 authorization server + consent (read/write scopes) | — | ✅ |
| Social login, sessions, multi-user orgs, invitations | — | ✅ |
| Works with claude.ai (web) | — | ✅ |

> **claude.ai requires OAuth.** Core ships no OAuth authorization server, so adding a Core instance to claude.ai (web) won't work out of the box. Claude Code, Cursor, Codex, and VS Code all accept a static bearer token and work fine.

## Architecture

- **Next.js App Router** — one static landing page, one MCP route (`/api/mcp`), one REST seed route (`/api/v1/collections`). Everything else is deleted.
- **Drizzle + Postgres** — records stored as JSONB, queried via containment operators and full-text search.
- **MCP server** — collection tools (including per-collection stats), record tools (store/query/search/update/delete/status/transform plus CSV/JSON export and import), schema tools (describe/infer/update), and view tools. Queries support filter operators (`$gt`/`$gte`/`$lt`/`$lte`/`$ne`/`$in`/`$nin`/`$exists`/`$contains`), field projection, and count/min/max/distinct/sum/avg aggregations.
- **Auth seam** (`src/lib/auth/seam.ts`) — the only place auth lives: bearer-key check when `HUTCH_API_KEY` is set, singleton context otherwise.
- **Singleton bootstrap** (`src/lib/auth/singleton.ts`) — one user, one personal org, created lazily on first request.

## Contributing

- **Found a bug?** [Open an issue](https://github.com/ExpeditedProjects/hutchdb/issues) with repro steps.
- **Want to improve Core?** PRs welcome — contributors sign a CLA so the maintainer can dual-license into HutchDB Cloud. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md).
- **Feedback or ideas?** Issues are the front door; tell us what you're building.

<details>
<summary><b>Development</b></summary>

```bash
npm test          # vitest
npm run smoke     # end-to-end smoke test against a running instance:
                  #   SMOKE_BASE_URL=http://localhost:3000 npm run smoke
                  #   (keyed mode: add SMOKE_API_KEY=...)
```

**Status**: stable enough for a single-user self-host. Breaking changes land on `main`; pin a commit if you need stability.

</details>

## License

[AGPL v3](LICENSE).

<p align="center">
  <a href="https://github.com/ExpeditedProjects/hutchdb/stargazers"><img src="https://img.shields.io/github/stars/ExpeditedProjects/hutchdb?style=social" alt="GitHub stars" /></a>&nbsp;
  <a href="https://github.com/ExpeditedProjects/hutchdb/issues"><img src="https://img.shields.io/github/issues/ExpeditedProjects/hutchdb" alt="Issues" /></a>&nbsp;
  <a href="https://github.com/ExpeditedProjects/hutchdb/commits/main"><img src="https://img.shields.io/github/last-commit/ExpeditedProjects/hutchdb" alt="Last commit" /></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ExpeditedProjects/hutchdb" alt="License" /></a>
</p>
