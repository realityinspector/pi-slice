FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/federation/package.json packages/federation/tsconfig.json ./packages/federation/

RUN pnpm install --no-frozen-lockfile

COPY packages/core/ ./packages/core/
COPY packages/federation/ ./packages/federation/

RUN pnpm --filter @slice/core build && pnpm --filter @slice/federation build

ENV PORT=7899
EXPOSE 7899

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:7899/health || exit 1

CMD ["node", "packages/federation/dist/broker-cli.js"]
