# syntax=docker/dockerfile:1.7

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma

# Stub DATABASE_URL so prisma.config.ts's env() resolver doesn't error during
# the postinstall `prisma generate`. No connection is made at build time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

RUN npm prune --omit=dev

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Commit count from the build host. Baked into the runtime image as the
# patch number for the sidebar version display, since the runtime has no
# .git directory for `git rev-list --count HEAD` to inspect. Defaults to
# "0" so a local `docker build` without --build-arg still produces a
# usable image (version will read as <minor>.0).
ARG POLARIS_BUILD_COMMIT_COUNT=0

ENV NODE_ENV=production \
    PORT=3000 \
    POLARIS_STATE_DIR=/app/state \
    POLARIS_BUILD_COMMIT_COUNT=${POLARIS_BUILD_COMMIT_COUNT}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client \
      iputils-ping \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/state/data/backups /app/state/public/uploads

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
