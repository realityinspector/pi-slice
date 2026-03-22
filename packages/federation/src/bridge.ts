export interface PeerBridgeConfig {
  workspaceName: string;
  workspacePort: number;
  brokerPort: number;
  onMessage?: (msg: { fromName: string; content: string; timestamp: number }) => void;
}

export class PeerBridge {
  private peerId: string | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private pollTimeout: NodeJS.Timeout | null = null;
  private brokerUrl: string;
  private running = false;

  // Exponential backoff state
  private pollBackoff = 2000;
  private heartbeatBackoff = 15000;
  private static readonly MIN_POLL_INTERVAL = 2000;
  private static readonly MAX_POLL_INTERVAL = 60000;
  private static readonly MIN_HEARTBEAT_INTERVAL = 15000;
  private static readonly MAX_HEARTBEAT_INTERVAL = 60000;

  constructor(private config: PeerBridgeConfig) {
    this.brokerUrl = `http://localhost:${config.brokerPort}`;
  }

  async start(): Promise<void> {
    await this.registerWithRetry();
    if (!this.peerId) return; // registration never succeeded

    this.running = true;
    this.scheduleHeartbeat();
    this.schedulePoll();
  }

  private async registerWithRetry(): Promise<void> {
    let attempt = 0;
    let delay = 2000;
    const maxDelay = 60000;

    while (true) {
      try {
        const res = await fetch(`${this.brokerUrl}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: this.config.workspaceName,
            port: this.config.workspacePort,
            pid: process.pid,
            cwd: process.cwd(),
          }),
        });
        const data = await res.json() as { id: string };
        this.peerId = data.id;
        console.log(`Peer bridge registered: ${this.config.workspaceName} (${this.peerId})`);
        return;
      } catch (err: any) {
        attempt++;
        console.warn(`Peer broker registration failed (attempt ${attempt}, next retry in ${Math.round(delay / 1000)}s): ${err.message}`);
        if (attempt >= 10) {
          console.warn(`Peer broker not available at ${this.brokerUrl} after ${attempt} attempts — giving up`);
          return; // Graceful degradation
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  }

  private scheduleHeartbeat() {
    if (!this.running) return;
    this.heartbeatTimeout = setTimeout(() => this.heartbeatTick(), this.heartbeatBackoff);
  }

  private async heartbeatTick() {
    if (!this.peerId || !this.running) return;
    try {
      await fetch(`${this.brokerUrl}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.peerId }),
      });
      // Success: reset backoff
      this.heartbeatBackoff = PeerBridge.MIN_HEARTBEAT_INTERVAL;
    } catch {
      // Failure: increase backoff
      this.heartbeatBackoff = Math.min(this.heartbeatBackoff * 2, PeerBridge.MAX_HEARTBEAT_INTERVAL);
    }
    this.scheduleHeartbeat();
  }

  private schedulePoll() {
    if (!this.running) return;
    this.pollTimeout = setTimeout(() => this.pollTick(), this.pollBackoff);
  }

  private async pollTick() {
    if (!this.peerId || !this.config.onMessage || !this.running) {
      this.schedulePoll();
      return;
    }
    try {
      const res = await fetch(`${this.brokerUrl}/poll-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.peerId }),
      });
      const data = await res.json() as { messages: Array<{ id?: string; fromName: string; content: string; timestamp: number }> };
      for (const msg of data.messages) {
        this.config.onMessage(msg);
        // Acknowledge receipt if the message has an id
        if (msg.id) {
          try {
            await fetch(`${this.brokerUrl}/ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messageId: msg.id, peerId: this.peerId }),
            });
          } catch { /* best-effort ack */ }
        }
      }
      // Success: reset backoff
      this.pollBackoff = PeerBridge.MIN_POLL_INTERVAL;
    } catch (err: any) {
      // Failure: increase backoff
      const prevBackoff = this.pollBackoff;
      this.pollBackoff = Math.min(this.pollBackoff * 2, PeerBridge.MAX_POLL_INTERVAL);
      const attemptNum = Math.round(Math.log2(this.pollBackoff / PeerBridge.MIN_POLL_INTERVAL)) + 1;
      console.warn(`Peer bridge poll failed (attempt ${attemptNum}, next retry in ${Math.round(this.pollBackoff / 1000)}s)`);
    }
    this.schedulePoll();
  }

  async listPeers(): Promise<Array<{ id: string; name: string; port: number }>> {
    if (!this.peerId) return [];
    try {
      const res = await fetch(`${this.brokerUrl}/list-peers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.peerId }),
      });
      const data = await res.json() as { peers: Array<{ id: string; name: string; port: number }> };
      return data.peers;
    } catch {
      return [];
    }
  }

  async sendMessage(toPeerId: string, content: string): Promise<boolean> {
    if (!this.peerId) return false;
    try {
      await fetch(`${this.brokerUrl}/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromId: this.peerId, toId: toPeerId, content }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    if (this.pollTimeout) clearTimeout(this.pollTimeout);
    if (this.peerId) {
      try {
        await fetch(`${this.brokerUrl}/unregister`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: this.peerId }),
        });
      } catch {}
    }
  }

  get isConnected(): boolean {
    return this.running && this.peerId !== null;
  }
}
