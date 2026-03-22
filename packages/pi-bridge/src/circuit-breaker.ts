export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailure = 0;
  private readonly maxFailures: number;
  private readonly resetTimeMs: number;

  constructor(opts: { maxFailures?: number; resetTimeMs?: number } = {}) {
    this.maxFailures = opts.maxFailures ?? 5;
    this.resetTimeMs = opts.resetTimeMs ?? 30000;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open — provider unavailable');
      }
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.maxFailures) {
      this.state = 'open';
      console.warn(`Circuit breaker opened after ${this.failures} failures. Will retry in ${this.resetTimeMs}ms`);
    }
  }

  getState(): CircuitState { return this.state; }
}
