# Contributing to Hutch

Thanks for your interest in contributing.

## Contributor License Agreement

Hutch is licensed AGPL v3, but the maintainer also offers a hosted version at [hutchdb.com](https://hutchdb.com) under a separate license. To support both distributions, contributors are asked to sign the Contributor License Agreement in [CLA.md](CLA.md) before their first pull request is merged.

The CLA grants the maintainer the right to redistribute your contribution under both AGPL v3 and the proprietary license used by the hosted product. You keep ownership of your contribution; you're not signing it away.

If you've configured [CLA Assistant](https://cla-assistant.io/) on this repository, signing is a one-click acceptance on the first PR you open and applies to all subsequent contributions.

## Getting set up

```bash
git clone https://github.com/ExpeditedProjects/hutchdb
cd hutchdb
npm install
cp .env.local.example .env.local
# edit .env.local with your database URL and admin credentials
npm run db:migrate
npm run db:seed
npm run dev
```

See [README.md](README.md) for the full quickstart.

## Tests

```bash
npm test        # vitest run
npm run test:watch
```

For features that change behavior, write failing tests against the agreed contract first, then implement to green. Tests live next to source as `*.test.ts(x)`.

### Integration tests (real Postgres)

Files matching `*.integration.test.ts` run generated SQL against a real scratch database — no mocks. They auto-skip when `HUTCH_TEST_DATABASE_URL` is unset, so plain `npm test` stays green with no infrastructure. To run them locally:

```bash
createdb hutch_test
HUTCH_TEST_DATABASE_URL=postgresql://localhost/hutch_test npm test
```

Use a dedicated scratch database — the suite applies migrations to it and truncates tables between tests. Never point it at your development database. CI runs this tier automatically against a `postgres:16` service (see `.github/workflows/test.yml`).

## What's in scope

Hutch is a personal-use structured data store for AI agents. Bug fixes, performance improvements, and small features that fit that purpose are welcome.

Out of scope for the OSS repo: multi-user collaboration, multi-tenant organizations, email invitations, billing, telemetry. Those live in the hosted product.

## Reporting bugs

Open an issue with reproduction steps, your environment (Node version, OS), and any relevant logs.
