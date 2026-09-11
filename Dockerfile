# syntax=docker/dockerfile:1.7

FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat

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
