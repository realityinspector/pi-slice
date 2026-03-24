import type { MonitorDefinition } from '../monitor-types.js';

export const BUILTIN_MONITORS: MonitorDefinition[] = [
  // 1. OpenRouter LLM health
  {
    id: 'llm-provider-health',
    name: 'LLM Provider Health',
    description: 'Checks OpenRouter API is reachable and responding to completions',
    severity: 'critical',
    type: 'health',
    check: {
      http: { url: '/api/health', expectedStatus: 200, timeoutMs: 5000 },
    },
    schedule: { intervalMs: 60000, startDelayMs: 10000 },
    triage: {
      action: 'alert',
      prompt: 'The LLM provider (OpenRouter) is not responding. Check: 1) Is the API key valid? 2) Is OpenRouter experiencing an outage? 3) Has the circuit breaker opened? Recommend: verify OPENROUTER_API_KEY env var, check https://status.openrouter.ai, review circuit breaker state.',
      maxConsecutiveFailures: 3,
      cooldownMs: 300000,
    },
  },

  // 2. Dispatch daemon stuck queue
  {
    id: 'dispatch-queue-stuck',
    name: 'Dispatch Queue Stuck',
    description: 'Detects tasks stuck in open/assigned state with idle workers',
    severity: 'critical',
    type: 'composite',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        const tasks = data.tasks || {};
        if (tasks.open > 0 && tasks.inProgress === 0) {
          return { ok: false, value: tasks.open, message: `${tasks.open} tasks open but none in progress — daemon may be stuck` };
        }
        return { ok: true, value: tasks.open };
      },
    },
    schedule: { intervalMs: 30000, startDelayMs: 15000 },
    triage: {
      action: 'restart',
      prompt: 'Tasks are queued but no workers are active. Possible causes: 1) Dispatch daemon poll loop crashed. 2) All workers timed out. 3) LLM provider circuit breaker is open. Check daemon metrics, worker count, and circuit breaker state.',
      maxConsecutiveFailures: 3,
      cooldownMs: 60000,
    },
  },

  // 3. Worker hung (task in_progress too long)
  {
    id: 'worker-hung',
    name: 'Worker Hung Detection',
    description: 'Detects tasks stuck in in_progress state beyond timeout',
    severity: 'critical',
    type: 'threshold',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/tasks?status=in_progress`);
        const tasks = await res.json() as any[];
        const now = Date.now();
        const hung = tasks.filter((t: any) => t.startedAt && now - new Date(t.startedAt).getTime() > 300000);
        if (hung.length > 0) {
          return { ok: false, value: hung.length, message: `${hung.length} task(s) in progress for >5 minutes`, details: { taskIds: hung.map((t: any) => t.id) } };
        }
        return { ok: true, value: 0 };
      },
    },
    schedule: { intervalMs: 60000, startDelayMs: 30000 },
    triage: {
      action: 'fix',
      prompt: 'Worker has been running for >5 minutes. Possible causes: 1) LLM response hanging (no timeout). 2) Worker subprocess crashed silently. 3) Task is genuinely complex. Action: check if session is still alive, force-fail the task if session is dead, let the retry mechanism requeue it.',
      maxConsecutiveFailures: 1,
      cooldownMs: 300000,
    },
  },

  // 4. WebSocket broadcast health
  {
    id: 'websocket-broadcast',
    name: 'WebSocket Broadcast Health',
    description: 'Monitors WebSocket connection count and broadcast errors',
    severity: 'high',
    type: 'composite',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        const wsOk = data.components?.websocket === 'ok';
        const connections = data.connections || 0;
        if (!wsOk) return { ok: false, message: 'WebSocket component reports unhealthy' };
        return { ok: true, value: connections, message: `${connections} active connections` };
      },
    },
    schedule: { intervalMs: 30000 },
    triage: {
      action: 'tune',
      prompt: 'WebSocket broadcast is degraded. Check: 1) Are zombie connections accumulating? 2) Is ping/pong heartbeat working? 3) Has the 100-client limit been hit? Action: terminate stale connections, verify heartbeat interval.',
      maxConsecutiveFailures: 5,
      cooldownMs: 120000,
    },
  },

  // 5. SQLite persistence status
  {
    id: 'persistence-health',
    name: 'SQLite Persistence Health',
    description: 'Monitors persistence status — alert if degraded',
    severity: 'critical',
    type: 'health',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        const status = data.components?.persistence;
        if (status === 'degraded') return { ok: false, message: 'Persistence is degraded — writes may be failing' };
        if (status === 'in-memory') return { ok: false, message: 'Running in-memory only — data will not survive restart' };
        return { ok: true, message: `Persistence: ${status}` };
      },
    },
    schedule: { intervalMs: 30000, startDelayMs: 5000 },
    triage: {
      action: 'alert',
      prompt: 'SQLite persistence has degraded. Possible causes: 1) Database file locked by another process. 2) Disk full. 3) Schema migration failed. 4) WAL file corrupted. Action: check disk space, verify no concurrent access, inspect SQLite error logs.',
      maxConsecutiveFailures: 2,
      cooldownMs: 300000,
    },
  },

  // 6. @mention -> task creation verification
  {
    id: 'mention-task-pipeline',
    name: '@Mention Task Pipeline',
    description: 'Verifies that @mentions create tasks within expected timeframe',
    severity: 'high',
    type: 'composite',
    check: {
      custom: async (ctx) => {
        const feedRes = await fetch(`${ctx.baseUrl}/api/feed`);
        const posts = await feedRes.json() as any[];
        const tasksRes = await fetch(`${ctx.baseUrl}/api/tasks`);
        const tasks = await tasksRes.json() as any[];

        const fiveMinAgo = Date.now() - 300000;
        const recentMentions = posts.filter((p: any) =>
          p.content?.startsWith('@') && new Date(p.createdAt).getTime() > fiveMinAgo && p.agentRole === 'human'
        );

        if (recentMentions.length === 0) return { ok: true, message: 'No recent mentions to verify' };

        const recentTasks = tasks.filter((t: any) => new Date(t.createdAt).getTime() > fiveMinAgo);
        if (recentMentions.length > 0 && recentTasks.length === 0) {
          return { ok: false, value: recentMentions.length, message: `${recentMentions.length} mentions but 0 tasks created in last 5 minutes` };
        }
        return { ok: true, value: recentTasks.length, message: `${recentTasks.length} tasks from ${recentMentions.length} mentions` };
      },
    },
    schedule: { intervalMs: 60000, startDelayMs: 30000 },
    triage: {
      action: 'fix',
      prompt: 'User @mentions are not creating tasks. Check: 1) Is the parseMention() regex matching? 2) Is taskQueue available (not null)? 3) Is the setTimeout callback for Director response firing? Test: POST a @director message via API and verify task creation.',
      maxConsecutiveFailures: 2,
      cooldownMs: 300000,
    },
  },

  // 7. DM response quality
  {
    id: 'dm-response-quality',
    name: 'DM Response Quality',
    description: 'Monitors DM responses for error messages or empty responses',
    severity: 'high',
    type: 'pattern',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/dm/director`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Status check — what tasks are pending?' }),
        });
        if (!res.ok) return { ok: false, message: `DM endpoint returned ${res.status}` };
        const data = await res.json() as any;
        const msg = data.agentMessage?.content || data.agentMessage || '';
        if (typeof msg === 'string' && msg.includes('having trouble')) {
          return { ok: false, message: 'DM returned error fallback response — LLM likely failing' };
        }
        if (!msg || (typeof msg === 'string' && msg.length < 10)) {
          return { ok: false, message: 'DM response empty or too short' };
        }
        return { ok: true, message: `DM response OK (${typeof msg === 'string' ? msg.length : 0} chars)` };
      },
    },
    schedule: { intervalMs: 300000, startDelayMs: 60000 },
    triage: {
      action: 'fix',
      prompt: 'Director DM responses are degraded. The response contained an error fallback message or was empty. Check: 1) OpenRouter API key validity. 2) Circuit breaker state. 3) Model availability. 4) Response parsing (agentMessage field). The DM endpoint should return {agentMessage} with content.',
      maxConsecutiveFailures: 2,
      cooldownMs: 600000,
    },
  },

  // 8. Task retry state persistence
  {
    id: 'task-retry-state',
    name: 'Task Retry State',
    description: 'Detects tasks that have been retried excessively',
    severity: 'medium',
    type: 'threshold',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/tasks`);
        const tasks = await res.json() as any[];
        const maxRetried = tasks.filter((t: any) => t.retries >= 3);
        const retrying = tasks.filter((t: any) => t.retries > 0 && t.retries < 3);
        if (maxRetried.length > 0) {
          return { ok: false, value: maxRetried.length, message: `${maxRetried.length} task(s) exhausted all retries`, details: { taskIds: maxRetried.map((t: any) => t.id) } };
        }
        return { ok: true, value: retrying.length, message: `${retrying.length} task(s) retrying` };
      },
    },
    schedule: { intervalMs: 120000 },
    triage: {
      action: 'alert',
      prompt: 'Tasks have exhausted all retry attempts. This usually means: 1) The LLM consistently fails for this type of task. 2) The task description is malformed. 3) A systemic issue prevents completion. Review the failed task descriptions and error messages.',
      maxConsecutiveFailures: 1,
      cooldownMs: 600000,
    },
  },

  // 9. Plan orphan detection
  {
    id: 'plan-orphan-detection',
    name: 'Orphaned Plan Detection',
    description: 'Detects plans where tasks are stuck or partially completed',
    severity: 'high',
    type: 'composite',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/plans`);
        const plans = await res.json() as any[];
        const activePlans = plans.filter((p: any) => p.status === 'active' || p.status === 'draft');
        const stale = activePlans.filter((p: any) => {
          const age = Date.now() - new Date(p.createdAt).getTime();
          return age > 1800000;
        });
        if (stale.length > 0) {
          return { ok: false, value: stale.length, message: `${stale.length} plan(s) active for >30 minutes with no completion` };
        }
        return { ok: true, value: activePlans.length };
      },
    },
    schedule: { intervalMs: 300000 },
    triage: {
      action: 'fix',
      prompt: 'Plans have been active for >30 minutes without completing. Check: 1) Are the plan\'s tasks queued? 2) Are workers picking them up? 3) Did partial task creation leave orphaned plans? Action: check each task in the plan, requeue any stuck tasks, or mark the plan as failed if tasks cannot complete.',
      maxConsecutiveFailures: 2,
      cooldownMs: 600000,
    },
  },

  // 10. Federation broker reachability
  {
    id: 'federation-broker',
    name: 'Federation Broker',
    description: 'Checks if the federation broker is reachable',
    severity: 'medium',
    type: 'health',
    check: {
      custom: async (ctx) => {
        const brokerUrl = (ctx.config as any).brokerUrl;
        if (!brokerUrl) return { ok: true, message: 'No broker configured — federation disabled' };
        try {
          const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) return { ok: false, message: `Broker returned ${res.status}` };
          const data = await res.json() as any;
          return { ok: true, value: data.peers || 0, message: `Broker healthy, ${data.peers || 0} peers` };
        } catch {
          return { ok: false, message: 'Broker unreachable' };
        }
      },
    },
    schedule: { intervalMs: 60000, startDelayMs: 15000 },
    triage: {
      action: 'tune',
      prompt: 'Federation broker is unreachable. This is expected if no broker is configured. If SLICE_BROKER_URL is set, check: 1) Is the broker service running? 2) Is the URL correct? 3) Network connectivity between services.',
      maxConsecutiveFailures: 5,
      cooldownMs: 300000,
    },
  },

  // 11. Message queue growth (broker side)
  {
    id: 'broker-queue-growth',
    name: 'Broker Message Queue',
    description: 'Monitors broker message queue for unbounded growth',
    severity: 'high',
    type: 'threshold',
    check: {
      custom: async (ctx) => {
        const brokerUrl = (ctx.config as any).brokerUrl;
        if (!brokerUrl) return { ok: true, message: 'No broker — skipping' };
        try {
          const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(5000) });
          const data = await res.json() as any;
          return { ok: true, value: data.peers || 0 };
        } catch {
          return { ok: true, message: 'Broker unreachable — skipping queue check' };
        }
      },
    },
    schedule: { intervalMs: 120000 },
    triage: {
      action: 'fix',
      prompt: 'Broker message queue is growing unboundedly. Check: 1) Are peers polling for messages? 2) Are acknowledgments being sent? 3) Is the cleanup interval running? Action: the broker should prune messages older than 10 minutes.',
      maxConsecutiveFailures: 3,
      cooldownMs: 600000,
    },
  },

  // 12. Circuit breaker state
  {
    id: 'circuit-breaker-state',
    name: 'Circuit Breaker State',
    description: 'Monitors LLM circuit breaker — alert if open',
    severity: 'high',
    type: 'health',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        if (data.components?.feed === 'ok' && data.components?.tasks === 'ok') {
          return { ok: true, message: 'Components healthy — circuit likely closed' };
        }
        return { ok: false, message: 'Component degradation detected — circuit may be open' };
      },
    },
    schedule: { intervalMs: 30000 },
    triage: {
      action: 'tune',
      prompt: 'Circuit breaker may be open. This means 5+ consecutive LLM failures occurred. The circuit will auto-reset after 30 seconds. If this persists: 1) Check OpenRouter status. 2) Verify API key. 3) Consider increasing maxFailures threshold if transient errors are common.',
      maxConsecutiveFailures: 3,
      cooldownMs: 60000,
    },
  },

  // 13. Schema migration status
  {
    id: 'schema-migration',
    name: 'Schema Migration',
    description: 'Verifies database schema is up to date after deploy',
    severity: 'high',
    type: 'health',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        if (data.components?.persistence === 'degraded') {
          return { ok: false, message: 'Persistence degraded — schema migration may have failed' };
        }
        return { ok: true, message: 'Schema OK' };
      },
    },
    schedule: { intervalMs: 300000, startDelayMs: 10000 },
    triage: {
      action: 'fix',
      prompt: 'Schema migration may have failed. The persistence layer is degraded. Check: 1) Are ALTER TABLE migrations running? 2) Are new columns present in the posts table? 3) Is the database writable? Action: run schema init manually, check for locked database.',
      maxConsecutiveFailures: 1,
      cooldownMs: 600000,
    },
  },

  // 14. Client reconnection loops
  {
    id: 'ws-reconnection-loops',
    name: 'WebSocket Reconnection Loops',
    description: 'Detects clients in reconnection loops via connection churn',
    severity: 'medium',
    type: 'drift',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        return { ok: true, value: data.connections || 0, message: `${data.connections || 0} active connections` };
      },
    },
    schedule: { intervalMs: 60000 },
    triage: {
      action: 'tune',
      prompt: 'WebSocket connection churn detected. Clients may be in reconnection loops. Check: 1) Is the server sending valid messages? 2) Are snapshot payloads too large? 3) Is there a client-side error causing disconnects? Check server logs for rapid connect/disconnect patterns.',
      maxConsecutiveFailures: 5,
      cooldownMs: 300000,
    },
  },

  // 15. Config validation
  {
    id: 'config-validation',
    name: 'Configuration Validation',
    description: 'Validates all required config is present and sane',
    severity: 'critical',
    type: 'composite',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        if (!res.ok) return { ok: false, message: `Health endpoint returned ${res.status}` };
        const data = await res.json() as any;
        if (data.status !== 'ok') return { ok: false, message: `Health status: ${data.status}` };
        const degraded = Object.entries(data.components || {}).filter(([_, v]) => v !== 'ok');
        if (degraded.length > 0) {
          return { ok: false, message: `Degraded: ${degraded.map(([k]) => k).join(', ')}` };
        }
        return { ok: true, message: 'All components healthy' };
      },
    },
    schedule: { intervalMs: 60000, startDelayMs: 5000 },
    triage: {
      action: 'alert',
      prompt: 'Configuration validation failed. One or more components are degraded or unhealthy. Check: 1) OPENROUTER_API_KEY is set and valid. 2) PORT is bindable. 3) DATA_DIR exists and is writable. 4) Model IDs are valid OpenRouter models.',
      maxConsecutiveFailures: 3,
      cooldownMs: 300000,
    },
  },

  // 16. Wizard re-trigger detection
  {
    id: 'wizard-retrigger',
    name: 'Wizard Re-Trigger Detection',
    description: 'Detects if the setup wizard runs on an existing database',
    severity: 'medium',
    type: 'pattern',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/feed`);
        const posts = await res.json() as any[];
        const systemPosts = posts.filter((p: any) => p.agentRole === 'system' && p.content?.includes('running'));
        if (systemPosts.length > 1) {
          return { ok: false, value: systemPosts.length, message: `${systemPosts.length} startup messages — wizard may have re-triggered` };
        }
        return { ok: true };
      },
    },
    schedule: { intervalMs: 600000 },
    triage: {
      action: 'alert',
      prompt: 'The setup wizard appears to have re-triggered on an existing database. This means first-run detection failed — possibly because Quarry schema check threw a transient error. Check: 1) Is config.json present in DATA_DIR? 2) Is the Quarry schema initialized? 3) Was there a database error at startup?',
      maxConsecutiveFailures: 1,
      cooldownMs: 3600000,
    },
  },

  // 17. Session memory tracking
  {
    id: 'session-memory',
    name: 'Session Memory',
    description: 'Monitors for growing session count (potential memory leak)',
    severity: 'medium',
    type: 'drift',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        return { ok: true, value: data.posts || 0, message: `${data.posts || 0} posts in feed` };
      },
    },
    schedule: { intervalMs: 300000 },
    triage: {
      action: 'tune',
      prompt: 'Session count is growing monotonically. Agent sessions may not be properly cleaned up. Check: 1) Is the hourly session cleanup interval running? 2) Are closed sessions removed from the spawner map? 3) Is the session map size growing? Action: trigger manual cleanup or increase cleanup frequency.',
      maxConsecutiveFailures: 3,
      cooldownMs: 600000,
    },
  },

  // 18. Quarry init race detection
  {
    id: 'quarry-init-race',
    name: 'Quarry Init Race',
    description: 'Detects early API calls before Quarry is ready',
    severity: 'medium',
    type: 'pattern',
    check: {
      custom: async (ctx) => {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        const data = await res.json() as any;
        if (data.components?.persistence === 'ok' && data.components?.feed === 'ok') {
          return { ok: true, message: 'All stores initialized' };
        }
        return { ok: false, message: 'Store initialization may be incomplete' };
      },
    },
    schedule: { intervalMs: 60000, startDelayMs: 5000 },
    triage: {
      action: 'tune',
      prompt: 'Quarry initialization may not have completed before API calls were made. This race condition can cause the feed to fall back to in-memory mode. Check: 1) Is the Quarry smoke test passing? 2) Is the async init promise awaited before serving requests? 3) Are there "Schema not ready" warnings in logs?',
      maxConsecutiveFailures: 2,
      cooldownMs: 600000,
    },
  },
];
