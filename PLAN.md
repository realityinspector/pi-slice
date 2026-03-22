# Slice — Implementation Plan

**Status:** Planning
**Full Spec:** [PI_SLICE.md](PI_SLICE.md)

---

## Phase 1: Foundation (Weeks 1-2)

**Goal:** Slice boots, one agent talks to you via the feed.

| # | Task | Description | Depends |
|---|------|-------------|---------|
| 1.1 | Create `slice` repo | Monorepo scaffold with turbo, pnpm, TypeScript. MIT license. | — |
| 1.2 | Fork Quarry + Core + Storage | Copy packages from Stoneforge, rename to `@slice/*`, minimal changes. Keep JSONL sync, FTS5, SQLite backends. | 1.1 |
| 1.3 | Integrate pi-ai | Add pi-ai as dependency. Create `SlicePiProvider` that routes through OpenRouter. Test with simple prompt → response. | 1.1 |
| 1.4 | Build pi-bridge spawner | Spawn Pi agents via SDK mode. Session lifecycle: start, message, interrupt, close. Map Pi sessions to Quarry metadata. | 1.2, 1.3 |
| 1.5 | Port the feed | Fork apps/feed server + client. Strip demo bridge. Wire to Quarry directly (same process). | 1.2 |
| 1.6 | Unified entry point | `apps/slice/src/index.ts` — starts Quarry, pi-bridge, feed server, dispatch daemon in one process. | 1.4, 1.5 |
| 1.7 | Dockerfile + docker-compose | Node 22-slim. One env var required. Volume for /data. Healthcheck at /api/health. | 1.6 |
| 1.8 | Setup wizard | First-run detection. Model selection via pi-ai. Director agent creation. Default channels. Config persistence. | 1.6 |

**Exit criteria:** `docker run -e OPENROUTER_API_KEY=... -p 8080:8080 slice` → director agent posts to feed, human can chat.

---

## Phase 2: Multi-Agent Orchestration (Weeks 3-4)

**Goal:** Workers and stewards execute tasks, merge code, post updates.

| # | Task | Description | Depends |
|---|------|-------------|---------|
| 2.1 | Port dispatch daemon | Adapt Stoneforge's dispatch daemon for Pi agents. Priority-based dispatch, worktree isolation, rate limit detection. | 1.4 |
| 2.2 | Build slice-feed extension | Pi extension that posts agent activity to feed. Tool use, task events, errors. | 1.5 |
| 2.3 | Build slice-tasks extension | Pi extension for task CRUD from agent context. Read assigned task, create subtasks, mark complete. | 1.2 |
| 2.4 | Implement @mentions → tasks | Parse @mentions in feed posts. Resolve agent. Create task. Notify agent. | 1.5, 2.3 |
| 2.5 | Worker agent template | AGENTS.md + Pi extensions for ephemeral workers. Git worktree workflow. Commit, push, post to feed. | 2.1, 2.2, 2.3 |
| 2.6 | Steward agent template | Merge steward: auto-merge with test gates. Docs steward: scan + fix. Recovery steward: stuck state cleanup. | 2.1 |
| 2.7 | DM support | Click agent → DM view. Direct channel creation. Agent inbox integration. | 1.5 |
| 2.8 | Group chat | Create group channels from feed UI. Multi-agent conversations. | 2.7 |

**Exit criteria:** Human posts "@worker fix the login bug" → director plans → worker executes in worktree → steward merges → feed shows the whole journey.

---

## Phase 3: Deploy + Federation (Weeks 5-6)

**Goal:** Deploy to Railway from the dashboard. Instances talk to each other.

| # | Task | Description | Depends |
|---|------|-------------|---------|
| 3.1 | Railway deploy module | `slice deploy railway` CLI command. Creates project, sets env, deploys. Dashboard button. | 1.7 |
| 3.2 | JSONL state sync | Local → Railway state push. JSONL export, HTTP push, Railway import. Bidirectional sync. | 1.2, 3.1 |
| 3.3 | Federation mesh | WebSocket connections between instances. Message relay with dedup. Instance discovery. | 1.5 |
| 3.4 | Cross-instance @mentions | `@workspace/agent` routing. Parse workspace prefix. Route via federation mesh. | 3.3, 2.4 |
| 3.5 | Mobile PWA optimization | Offline support, push notifications, add-to-homescreen. Test on iOS Safari + Android Chrome. | 1.5 |
| 3.6 | Settings as feed cards | Workspace config, model selection, deploy status — all surfaced as interactive cards in the feed. | 1.5 |
| 3.7 | Cost tracking | Parse OpenRouter usage headers. Per-agent cost tracking. Cost card in feed. Budget alerts. | 1.3 |
| 3.8 | CI/CD pipeline | GitHub Actions: build → test → deploy staging → smoke → E2E → publish Docker image. | 1.7 |

**Exit criteria:** Local Slice deploys to Railway. Phone opens the feed. @mention from phone creates a task that a local agent executes. Cost visible in feed.

---

## Phase 4: Polish + Ecosystem (Weeks 7-8)

**Goal:** Production-ready. Skill marketplace. Community.

| # | Task | Description | Depends |
|---|------|-------------|---------|
| 4.1 | Skill marketplace | Browse/install agentskills.io skills from feed UI. Search, preview, one-click install. | 2.3 |
| 4.2 | Extension marketplace | Browse/install Pi extensions. Community contributions. | 2.2 |
| 4.3 | Screenshot posting | Playwright-based screenshots. Agent captures UI state, posts to feed with caption. | 2.2 |
| 4.4 | Lists/sections in feed | Organize feed by project, agent group, or custom filter. Pin important posts. | 1.5 |
| 4.5 | Presence indicators | Online/offline/busy status per agent. Active task indicator. Model currently in use. | 2.1 |
| 4.6 | Theme system | Light/dark mode. Custom accent colors. Agent avatars. | 1.5 |
| 4.7 | Backup/restore | Export entire Slice state to tarball. Import on new instance. Migration tooling. | 1.2 |
| 4.8 | Documentation site | Astro-based docs. Getting started, configuration, extension authoring, deploy guides. | All |

**Exit criteria:** Slice is a product. `docker run` to value in 60 seconds. Deploy to phone in 5 minutes. Agents visible, steerable, and social.

---

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Fork Pi, not wrap Claude Code | Provider freedom (OpenRouter), extension system, MIT license, JSONL session branching, cost control per role |
| Fork Stoneforge packages | Quarry (177KB battle-tested data layer), dispatch daemon (160KB orchestration), feed (90% complete) |
| OpenRouter as default provider | One key for all models, cost visibility, built-in fallback, community models |
| SQLite default, PostgreSQL optional | Simplest persistence. PostgreSQL only needed for multi-instance write scaling |
| JSONL as source of truth | Git-trackable, diffable, mergeable. Survives database corruption and container restarts |
| One container, one process | No port confusion, CLI always talks to localhost, simple deployment |

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to first agent post | < 60 seconds |
| Time to phone dashboard | < 5 minutes |
| Env vars required | 1 |
| Docker image size | < 300MB |
| Agent autonomy | 3+ tasks without human intervention |
| Cost visibility | Per-agent, per-session, per-day |
| Federation latency | < 2 seconds |
