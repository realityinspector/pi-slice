export interface PeerBridgeConfig {
  workspaceName: string;
  workspacePort: number;
  brokerPort: number;
  onMessage?: (msg: { fromName: string; content: string; timestamp: number }) => void;
}

export class PeerBridge {
  private peerId: string | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private brokerUrl: string;
  private running = false;

  constructor(private config: PeerBridgeConfig) {
    this.brokerUrl = `http://localhost:${config.brokerPort}`;
  }

  async start(): Promise<void> {
    // Register with broker
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
      this.running = true;
      console.log(`Peer bridge registered: ${this.config.workspaceName} (${this.peerId})`);
    } catch (err: any) {
      console.warn(`Peer broker not available at ${this.brokerUrl}: ${err.message}`);
      return; // Graceful degradation
    }

    // Heartbeat every 15s
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 15000);

    // Poll for messages every 2s
    this.pollInterval = setInterval(() => this.poll(), 2000);
  }

  private async heartbeat() {
    if (!this.peerId) return;
    try {
      await fetch(`${this.brokerUrl}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.peerId }),
      });
    } catch {}
  }

  private async poll() {
    if (!this.peerId || !this.config.onMessage) return;
    try {
      const res = await fetch(`${this.brokerUrl}/poll-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.peerId }),
      });
      const data = await res.json() as { messages: Array<{ fromName: string; content: string; timestamp: number }> };
      for (const msg of data.messages) {
        this.config.onMessage(msg);
      }
    } catch {}
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
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.pollInterval) clearInterval(this.pollInterval);
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
