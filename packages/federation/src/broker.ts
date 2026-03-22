import http from 'http';
import { randomBytes } from 'crypto';

interface Peer {
  id: string;
  name: string;
  port: number;
  pid: number;
  cwd: string;
  registeredAt: number;
  lastHeartbeat: number;
}

interface Message {
  id: string;
  fromId: string;
  toId: string;
  content: string;
  timestamp: number;
  delivered: boolean;
}

export class PeerBroker {
  private peers = new Map<string, Peer>();
  private messages: Message[] = [];
  private server: http.Server;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private port: number = 7899) {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    res.setHeader('Content-Type', 'application/json');

    // Parse JSON body
    let body: any = {};
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    }

    switch (url.pathname) {
      case '/health':
        res.end(JSON.stringify({ status: 'ok', peers: this.peers.size }));
        break;

      case '/register': {
        // Register a new peer. Returns { id }
        const id = randomBytes(4).toString('hex');
        this.peers.set(id, {
          id,
          name: body.name,
          port: body.port,
          pid: body.pid,
          cwd: body.cwd,
          registeredAt: Date.now(),
          lastHeartbeat: Date.now(),
        });
        res.end(JSON.stringify({ id }));
        break;
      }

      case '/heartbeat': {
        const peer = this.peers.get(body.id);
        if (peer) peer.lastHeartbeat = Date.now();
        res.end(JSON.stringify({ ok: !!peer }));
        break;
      }

      case '/list-peers': {
        const peers = Array.from(this.peers.values())
          .filter(p => p.id !== body.id) // exclude self
          .map(p => ({ id: p.id, name: p.name, port: p.port }));
        res.end(JSON.stringify({ peers }));
        break;
      }

      case '/send-message': {
        const msg: Message = {
          id: randomBytes(4).toString('hex'),
          fromId: body.fromId,
          toId: body.toId,
          content: body.content,
          timestamp: Date.now(),
          delivered: false,
        };
        this.messages.push(msg);
        res.end(JSON.stringify({ ok: true, messageId: msg.id }));
        break;
      }

      case '/poll-messages': {
        const undelivered = this.messages.filter(m => m.toId === body.id && !m.delivered);
        undelivered.forEach(m => m.delivered = true);
        // Include sender name
        const enriched = undelivered.map(m => {
          const sender = this.peers.get(m.fromId);
          return { ...m, fromName: sender?.name || 'unknown' };
        });
        res.end(JSON.stringify({ messages: enriched }));
        break;
      }

      case '/unregister':
        this.peers.delete(body.id);
        res.end(JSON.stringify({ ok: true }));
        break;

      default:
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`Peer broker running on port ${this.port}`);
        // Cleanup stale peers every 30s
        this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
        resolve();
      });
    });
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      // Remove peers that haven't sent heartbeat in 60s
      if (now - peer.lastHeartbeat > 60000) {
        this.peers.delete(id);
      }
    }
    // Remove old delivered messages (> 5 min)
    this.messages = this.messages.filter(m => !m.delivered || now - m.timestamp < 300000);
  }

  stop(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
