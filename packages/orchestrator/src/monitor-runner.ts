import type { MonitorDefinition, MonitorState, MonitorContext, CheckResult } from './monitor-types.js';

export interface MonitorRunnerConfig {
  baseUrl: string;
  db: any | null;
  taskQueue: any;
  config: Record<string, unknown>;
  onAlert: (monitor: MonitorDefinition, state: MonitorState, result: CheckResult) => void;
  onRecover: (monitor: MonitorDefinition, state: MonitorState) => void;
}

export class MonitorRunner {
  private monitors = new Map<string, { def: MonitorDefinition; state: MonitorState; timer: ReturnType<typeof setTimeout> | null }>();
  private running = false;
  private ctx: MonitorContext;

  constructor(private config: MonitorRunnerConfig) {
    this.ctx = {
      baseUrl: config.baseUrl,
      db: config.db,
      taskQueue: config.taskQueue,
      config: config.config,
    };
  }

  register(monitors: MonitorDefinition[]): void {
    for (const def of monitors) {
      this.monitors.set(def.id, {
        def,
        state: {
          id: def.id,
          lastCheck: 0,
          lastResult: { ok: true },
          consecutiveFailures: 0,
          lastAlertAt: 0,
          totalChecks: 0,
          totalFailures: 0,
        },
        timer: null,
      });
    }
  }

  start(): void {
    this.running = true;
    for (const [id, entry] of this.monitors) {
      const delay = entry.def.schedule.startDelayMs || 0;
      entry.timer = setTimeout(() => {
        this.runCheck(id);
        entry.timer = setInterval(() => this.runCheck(id), entry.def.schedule.intervalMs) as unknown as ReturnType<typeof setTimeout>;
      }, delay);
    }
    console.log(`Monitor runner started: ${this.monitors.size} monitors registered`);
  }

  private async runCheck(id: string): Promise<void> {
    if (!this.running) return;
    const entry = this.monitors.get(id);
    if (!entry) return;

    const { def, state } = entry;

    // Skip if silenced
    if (def.silencedUntil && Date.now() < def.silencedUntil) return;

    let result: CheckResult;
    try {
      if (def.check.http) {
        const url = def.check.http.url.startsWith('/') ? `${this.ctx.baseUrl}${def.check.http.url}` : def.check.http.url;
        const res = await fetch(url, { signal: AbortSignal.timeout(def.check.http.timeoutMs || 10000) });
        result = { ok: res.status === (def.check.http.expectedStatus || 200), value: res.status, message: `HTTP ${res.status}` };
      } else if (def.check.custom) {
        result = await def.check.custom(this.ctx);
      } else {
        result = { ok: true, message: 'No check configured' };
      }
    } catch (err: any) {
      result = { ok: false, message: `Check error: ${err.message}` };
    }

    // Update state
    state.lastCheck = Date.now();
    state.lastResult = result;
    state.totalChecks++;

    if (!result.ok) {
      state.consecutiveFailures++;
      state.totalFailures++;

      const maxFail = def.triage.maxConsecutiveFailures || 3;
      const cooldown = def.triage.cooldownMs || 300000;
      const shouldAlert = state.consecutiveFailures >= maxFail && (Date.now() - state.lastAlertAt > cooldown);

      if (shouldAlert) {
        state.lastAlertAt = Date.now();
        this.config.onAlert(def, { ...state }, result);
      }
    } else {
      if (state.consecutiveFailures > 0) {
        this.config.onRecover(def, { ...state });
      }
      state.consecutiveFailures = 0;
    }
  }

  stop(): void {
    this.running = false;
    for (const [_, entry] of this.monitors) {
      if (entry.timer) clearInterval(entry.timer as any);
      entry.timer = null;
    }
    console.log('Monitor runner stopped');
  }

  getState(): MonitorState[] {
    return Array.from(this.monitors.values()).map(e => ({ ...e.state }));
  }

  getMonitors(): MonitorDefinition[] {
    return Array.from(this.monitors.values()).map(e => e.def);
  }

  silenceMonitor(id: string, durationMs: number): boolean {
    const entry = this.monitors.get(id);
    if (!entry) return false;
    entry.def.silencedUntil = Date.now() + durationMs;
    return true;
  }

  get isRunning(): boolean { return this.running; }
}
