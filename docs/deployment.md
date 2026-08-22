# Deployment

Hutch is a standard Next.js + Postgres app. Nothing forces a specific host — pick the path that fits.

## Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `HUTCH_DATABASE_URL` | ✅ | Postgres connection string. |
| `HUTCH_ADMIN_EMAIL` | ✅ | Identifies the singleton admin user in the database. |
| `HUTCH_ADMIN_PASSWORD` | ✅ | The password for the web UI login. |
| `HUTCH_SESSION_SECRET` | ✅ | 32+ random bytes for signing the session cookie. Generate with `openssl rand -hex 32`. |
| `HUTCH_BASE_URL` | recommended | Public URL clients see (e.g., `https://hutch.example.com`). Defaults to `http://localhost:3000`. OAuth metadata and absolute URLs are generated from this. |
| `HUTCH_AUTO_SEED` | optional | When `true`, the Docker entrypoint seeds the singleton admin user + org on first start. Idempotent. |

---

## Option 1 — Docker (recommended for self-hosters)

Brings up Hutch and Postgres together with one command.

```bash
git clone https://github.com/ExpeditedProjects/hutchdb
cd hutchdb

export HUTCH_ADMIN_PASSWORD="change-me"
export HUTCH_SESSION_SECRET="$(openssl rand -hex 32)"

docker compose up
```

Visit `http://localhost:3000` and sign in with the password.

The container entrypoint runs database migrations on every start (idempotent) and, when `HUTCH_AUTO_SEED=true` (default in `docker-compose.yml`), creates the singleton admin user + org if they don't already exist.

### Putting it behind a reverse proxy

For production, terminate TLS at nginx/Caddy and forward to the container. Example Caddyfile:

```
hutch.example.com {
  reverse_proxy localhost:3000
}
```

Then set `HUTCH_BASE_URL=https://hutch.example.com` in the environment so OAuth metadata and any absolute URLs Hutch emits reflect the public origin instead of `localhost`.

### Bring your own Postgres

If you'd rather run Postgres separately (managed RDS, Supabase, Neon, your own server), delete the `postgres` service from `docker-compose.yml` and point `HUTCH_DATABASE_URL` at your instance.

---

## Option 2 — Node directly on a server

For VPS or homelab deployments without Docker.

```bash
git clone https://github.com/ExpeditedProjects/hutchdb
cd hutchdb
npm ci

# Set env vars however your platform expects (export, .env.local,
# systemd EnvironmentFile, etc.)
export HUTCH_DATABASE_URL=postgresql://...
export HUTCH_ADMIN_EMAIL=admin@example.com
export HUTCH_ADMIN_PASSWORD=...
export HUTCH_SESSION_SECRET="$(openssl rand -hex 32)"
export HUTCH_BASE_URL=https://hutch.example.com

npm run db:migrate
npm run db:seed
npm run build:app
npm start
```

`npm start` runs `next start` on port 3000 by default. Put nginx/Caddy in front for TLS, same as Option 1.

For process management, run under systemd, pm2, or whatever your platform prefers. The standalone server is at `node .next/standalone/server.js` if you want to drop the Next.js wrapper.

---

## Option 3 — Vercel

Connect the repo, add the env vars from the table above in the project's settings, deploy. The `build` script (which Vercel runs) is `npx tsx scripts/migrate.ts && next build` — it applies any pending migrations before the build, so deploys roll forward the schema automatically.

For Postgres, anything reachable from Vercel functions works: Neon, Supabase, RDS, your own. Set `HUTCH_DATABASE_URL` accordingly.

Set `HUTCH_BASE_URL` to your Vercel domain (or your custom domain) so OAuth metadata uses it instead of the internal `*.vercel.app` URL.

---

## Migrations

Three migration paths, all use the same `drizzle/` SQL files:

| Command | When | Notes |
|---|---|---|
| `npm run db:migrate` | Local dev, Node deploys | Uses `drizzle-kit migrate`. Reads `.env.local`. |
| `npx tsx scripts/migrate.ts` | Vercel `build` step | Same as above but seeds the journal for pre-migrator databases. Safe on fresh DBs too. |
| `node scripts/docker-migrate.js` | Docker entrypoint | Pure pg-only runner, no drizzle-kit dependency. Used by `Dockerfile`. |

All three produce the same end state. Pick whichever fits your deploy.

---

## Troubleshooting

- **`HUTCH_SESSION_SECRET is required`** at startup — generate one with `openssl rand -hex 32` and set it in the environment.
- **Login returns 401 even with the right password** — `HUTCH_ADMIN_PASSWORD` may have a trailing newline (common when pasting). Trim it.
- **Login succeeds but `/dashboard` returns 307 back to `/login`** — `HUTCH_ADMIN_EMAIL` doesn't match a row in the `user` table. Either run `npm run db:seed` (or set `HUTCH_AUTO_SEED=true` for Docker) or check the email matches exactly.
- **OAuth metadata at `/.well-known/oauth-authorization-server` shows `localhost` URLs in production** — `HUTCH_BASE_URL` isn't set. Set it to your public origin.
