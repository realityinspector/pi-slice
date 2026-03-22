FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy package files first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/storage/package.json packages/storage/tsconfig.json ./packages/storage/
COPY packages/quarry/package.json packages/quarry/tsconfig.json ./packages/quarry/
COPY packages/shared-routes/package.json packages/shared-routes/tsconfig.json ./packages/shared-routes/
COPY packages/orchestrator/package.json packages/orchestrator/tsconfig.json ./packages/orchestrator/
COPY packages/pi-bridge/package.json packages/pi-bridge/tsconfig.json ./packages/pi-bridge/
COPY packages/feed/package.json packages/feed/tsconfig.json ./packages/feed/
COPY packages/feed/client/package.json ./packages/feed/client/
COPY packages/federation/package.json packages/federation/tsconfig.json ./packages/federation/
COPY packages/deploy/package.json packages/deploy/tsconfig.json ./packages/deploy/
COPY apps/slice/package.json apps/slice/tsconfig.json ./apps/slice/

RUN pnpm install --no-frozen-lockfile

# Copy source and build
COPY . .

# Install feed client deps (not in pnpm workspace, needs platform-specific rollup)
RUN cd packages/feed/client && npm install

RUN pnpm build

# Production stage
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps

# Create data volume
RUN mkdir -p /data

ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080


HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "apps/slice/dist/index.js"]
