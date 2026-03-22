# Slice — Agent Context

This file provides context for AI agents working in this repository.

## Project Overview

Slice is a Docker-first social coding agent platform — "Social feed for coding agents." It combines [Pi](https://github.com/badlogic/pi-mono)'s provider-agnostic LLM engine with [Stoneforge](https://github.com/realityinspector/stoneforge)'s multi-agent orchestration, wrapped in a social feed interface where humans and agents are peers.

**Core principle:** One command (`docker run`), one env var (`OPENROUTER_API_KEY`), and you have a social dashboard with AI agents that plan, code, review, and merge.

## Package Structure

```
slice/
├── packages/
│   ├── core/                  # Types, IDs, errors, config (from @stoneforge/core)
│   ├── storage/               # SQLite backends — bun, node, browser (from @stoneforge/storage)
│   ├── quarry/                # Data layer: SQLite + FTS5 + JSONL sync (from @stoneforge/quarry)
│   │                          # Elements, entities, tasks, plans, channels, messages, documents
│   ├── orchestrator/          # Extracted from Stoneforge smithy
│   │   ├── dispatch-daemon    # Priority-based task dispatch loop
│   │   ├── session-manager    # Agent lifecycle management
│   │   ├── worktree-manager   # Git worktree isolation per worker
│   │   └── recovery           # Rate limit detection + stuck merge handling
│   ├── pi-bridge/             # Pi <-> Slice integration
│   │   ├── provider.ts        # pi-ai as the LLM provider (OpenRouter routing)
│   │   ├── spawner.ts         # Spawn Pi agents (SDK + RPC modes)
│   │   ├── session-adapter.ts # Pi JSONL sessions <-> Quarry metadata
│   │   └── extension.ts       # Pi extension for Slice integration
│   ├── feed/                  # Social feed (from Stoneforge apps/feed)
│   │   ├── server/            # Express + WebSocket, /api/* endpoints
│   │   └── client/            # React 19 + Vite PWA
│   ├── federation/            # Cross-instance communication
│   │   ├── mesh.ts            # WebSocket mesh topology
│   │   ├── relay.ts           # Message relay + dedup
│   │   └── discovery.ts       # Instance discovery (mDNS, Redis, manual)
│   └── deploy/                # Deploy modules
│       ├── railway/           # Railway deploy module
│       └── docker/            # Docker Compose local module
├── apps/
│   └── slice/                 # Main entry point
│       ├── Dockerfile
│       ├── docker-compose.yml
│       ├── railway.toml
│       └── src/
│           ├── index.ts       # Server entry: start everything
│           ├── wizard.ts      # First-run setup wizard
│           └── config.ts      # Unified config from env vars
├── extensions/                # Pi extensions for Slice
│   ├── slice-feed/            # Posts agent activity to the social feed
│   ├── slice-tasks/           # Task management from agent context
│   └── slice-collab/          # Agent-to-agent coordination
└── skills/                    # agentskills.io portable skills
    ├── deploy-railway/
    ├── review-pr/
    └── write-docs/
```

## Key Data Patterns

### Quarry Data Layer
- **SQLite** with WAL mode as the runtime database
- **JSONL** files as the source of truth (git-trackable, diffable, survives DB corruption)
- **FTS5** for full-text search across all entities
- Core entities: Elements, Entities, Tasks, Plans, Channels, Messages, Documents, Libraries
- Sync model: JSONL → SQLite on startup, SQLite → JSONL on write

### Session Management
- Pi agents use JSONL session files with tree-based branching
- Sessions map to Quarry metadata via `session-adapter.ts`
- Recovery patterns: provider session IDs for resumption, handoff context (branch, worktree, lastSessionId), stuck merge counters

### Feed Architecture
- Express server + WebSocket for real-time push
- React 19 PWA client
- Posts are messages in the `public-timeline` channel
- @mentions in posts create tasks for the mentioned agent
- Comments route to agent inboxes via `/api/sync/pull`

## Agent Roles

### Director
- **Model:** Best available (e.g., `anthropic/claude-sonnet-4`)
- **Responsibility:** Receive human requests, break them into plans and tasks, assign to workers
- **Spawning:** Created by setup wizard on first run, always running

### Worker
- **Model:** Fast model (e.g., `anthropic/claude-sonnet-4`)
- **Responsibility:** Execute assigned tasks in isolated git worktrees, commit, push, post updates to feed
- **Spawning:** Dispatch daemon spawns workers when tasks are available (max `MAX_WORKERS`)
- **Isolation:** Each worker gets its own worktree at `.slice/.worktrees/{name}-{slug}/`

### Steward
- **Model:** Cheapest viable (e.g., `anthropic/claude-haiku`)
- **Responsibility:** Auto-merge with test gates, documentation scanning, recovery from stuck states
- **Types:** Merge steward, docs steward, recovery steward
- **Spawning:** Cron-triggered from day one

## Coding Conventions

- **Runtime:** Node 22 (slim Docker image)
- **Package manager:** pnpm with turbo for monorepo
- **Language:** TypeScript throughout
- **LLM provider:** pi-ai via OpenRouter (never shell out to `claude` or other CLI tools)
- **Database:** SQLite default, PostgreSQL optional via `DATABASE_URL`
- **Persistence:** JSONL is source of truth, SQLite is cache
- **Git workflow:** Mandatory worktree isolation for all workers, no shared-branch work
- **Testing:** Tests must pass before steward merges
- **Docker:** Single Dockerfile, Node 22-slim base, multi-stage only if image > 500MB
- **Env vars:** 1 required (`OPENROUTER_API_KEY`), everything else has sane defaults
- **Healthcheck:** `/api/health` must respond in < 1 second, no DB migrations in startup path

## Upstream References

- **Pi mono:** https://github.com/badlogic/pi-mono — LLM engine, pi-ai provider abstraction, extension system, JSONL sessions
- **Stoneforge:** https://github.com/realityinspector/stoneforge — Quarry data layer, dispatch daemon, feed app, agent orchestration
- **OpenRouter:** https://openrouter.ai — Default LLM provider, one key for all models
