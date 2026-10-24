# syntax=docker/dockerfile:1.7

FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat
# Node before 26.12.1 has the Brotli decoder RCE (CVE-2026-111497). The tag
# moves, but a cached base layer doesn't: fail the build instead of shipping it.
# Rebuild with `docker compose build --pull` to fetch a patched base.
RUN node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a*1e6+b*1e3+c < 26012001) { console.error(`Node ${process.version} is older than 26.12.1 (CVE-2026-111497); rebuild with --pull`); process.exit(1) }'

# ---- deps -----------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder --------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build:app

# ---- runner ---------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone build output (next traces only the dependencies actually used)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrations + entrypoint scripts (pg-only, no drizzle-kit needed at runtime)
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts/docker-migrate.js ./scripts/docker-migrate.js
COPY --from=builder --chown=nextjs:nodejs /app/scripts/docker-seed.js ./scripts/docker-seed.js
COPY --from=builder --chown=nextjs:nodejs /app/scripts/docker-entrypoint.sh /docker-entrypoint.sh

USER nextjs
EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.js"]
