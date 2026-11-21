# syntax=docker/dockerfile:1.7
# One image recipe, two runnable targets: `api` (REST + web app) and `worker`.
#   docker build --target api -t deadletter-api .
#   docker build --target worker -t deadletter-worker .
# Local development does not need Docker; hosting platforms build this from GitHub.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV HUSKY=0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
# Prisma's query engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- install all dependencies (cached unless a manifest changes) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/runtime/package.json packages/runtime/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
RUN npm ci --ignore-scripts=false

# ---- build web, api, worker; then drop dev dependencies ----
FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- shared runtime layer ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/db ./packages/db
USER node

FROM runtime AS api
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA} PORT=8080 WEB_DIST_DIR=/app/apps/web/dist
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]

FROM runtime AS worker
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
CMD ["node", "--enable-source-maps", "apps/worker/dist/main.js"]

# One-off job that applies database migrations before each release.
FROM runtime AS migrate
WORKDIR /app/packages/db
CMD ["npx", "prisma", "migrate", "deploy"]

# Single-service image: API + web app + in-process worker (docs/adr/0009).
# Keep this stage LAST: Render builds the final stage and has no option to choose a target.
FROM api AS all
ENV RUN_WORKER=true
