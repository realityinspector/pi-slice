import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SliceConfig {
  openrouterApiKey: string;
  port: number;
  dataDir: string;
  directorModel: string;
  workerModel: string;
  stewardModel: string;
  maxWorkers: number;
  databaseUrl?: string;
  federationPeers: string[];
  authToken: string;
  gitRemote?: string;
  seedDemo: boolean;
}

export function loadConfig(): SliceConfig {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('ERROR: OPENROUTER_API_KEY is required. Set it in .env or as an environment variable.');
    process.exit(1);
  }

  return {
    openrouterApiKey: apiKey,
    port: parseInt(process.env.PORT || '8080', 10),
    dataDir: process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), '.slice', 'data')),
    directorModel: process.env.DIRECTOR_MODEL || 'anthropic/claude-sonnet-4',
    workerModel: process.env.WORKER_MODEL || 'anthropic/claude-sonnet-4',
    stewardModel: process.env.STEWARD_MODEL || 'anthropic/claude-haiku',
    maxWorkers: parseInt(process.env.MAX_WORKERS || '3', 10),
    databaseUrl: process.env.DATABASE_URL,
    federationPeers: process.env.FEDERATION_PEERS?.split(',').filter(Boolean) || [],
    authToken: process.env.AUTH_TOKEN || crypto.randomUUID(),
    gitRemote: process.env.GIT_REMOTE,
    seedDemo: process.env.SEED_DEMO === 'true',
  };
}
