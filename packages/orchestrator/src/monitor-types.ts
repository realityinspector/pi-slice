export type MonitorSeverity = 'critical' | 'high' | 'medium' | 'low';
export type MonitorType = 'health' | 'threshold' | 'pattern' | 'composite' | 'drift';
export type CheckResult = { ok: boolean; value?: number; message?: string; details?: Record<string, unknown> };
export type TriageAction = 'alert' | 'tune' | 'fix' | 'restart' | 'ignore';

export interface MonitorDefinition {
  id: string;
  name: string;
  description: string;
  severity: MonitorSeverity;
  type: MonitorType;

  /** What to check */
  check: MonitorCheck;

  /** When to run */
  schedule: {
    intervalMs: number;
    startDelayMs?: number;
  };

  /** What to do when check fails */
  triage: {
    action: TriageAction;
    prompt?: string;
    maxConsecutiveFailures?: number;
    cooldownMs?: number;
  };

  /** PR fixing this issue (dedup) */
  prLink?: string;
  /** Epoch ms — don't fire until this time */
  silencedUntil?: number;
}

export interface MonitorCheck {
  http?: { url: string; expectedStatus?: number; timeoutMs?: number };
  metric?: { name: string; op: '>' | '<' | '==' | '!='; threshold: number };
  query?: { sql: string; expectRows?: number; expectEmpty?: boolean };
  custom?: (ctx: MonitorContext) => Promise<CheckResult>;
}

export interface MonitorContext {
  baseUrl: string;
  db: any | null;
  taskQueue: any;
  config: Record<string, unknown>;
}

export interface MonitorState {
  id: string;
  lastCheck: number;
  lastResult: CheckResult;
  consecutiveFailures: number;
  lastAlertAt: number;
  totalChecks: number;
  totalFailures: number;
}
