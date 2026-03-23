import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SliceConfig {
  openrouterApiKey: string;      // Required — from OPENROUTER_API_KEY
  port: number;                  // Default 8080
  dataDir: string;               // Default /data (Docker) or .slice/data (local)
  directorModel: string;         // Default anthropic/claude-sonnet-4
  workerModel: string;           // Default anthropic/claude-sonnet-4
  stewardModel: string;          // Default anthropic/claude-haiku
  maxWorkers: number;            // Default 3
  databaseUrl?: string;          // Optional PostgreSQL override
  federationPeers: string[];     // Optional peer URLs
  authToken: string;             // Auto-generated if not provided
  gitRemote?: string;            // Optional git remote for push
  seedDemo: boolean;
}

export function loadConfig(): SliceConfig {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      '\n' +
      '╔══════════════════════════════════════════════════════════════╗\n' +
      '║  ERROR: OPENROUTER_API_KEY is required                      ║\n' +
      '║                                                              ║\n' +
      '║  Set it in your environment or create a .env file:          ║\n' +
      '║    echo "OPENROUTER_API_KEY=sk-or-..." > .env               ║\n' +
      '║                                                              ║\n' +
      '║  Get a key at: https://openrouter.ai/keys                   ║\n' +
      '╚══════════════════════════════════════════════════════════════╝\n'
    );
    process.exit(1);
  }

  const config: SliceConfig = {
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

  return config;
}

/**
 * Log the loaded configuration (redacting secrets).
 */
export function logConfig(config: SliceConfig): void {
  console.log('');
  console.log('Configuration:');
  console.log(`  Port:           ${config.port}`);
  console.log(`  Data directory:  ${config.dataDir}`);
  console.log(`  Max workers:     ${config.maxWorkers}`);
  console.log('');
  console.log('Models:');
  console.log(`  Director:  ${config.directorModel}`);
  console.log(`  Worker:    ${config.workerModel}`);
  console.log(`  Steward:   ${config.stewardModel}`);
  console.log('');
  if (config.federationPeers.length > 0) {
    console.log(`Federation peers: ${config.federationPeers.join(', ')}`);
  }
  if (config.gitRemote) {
    console.log(`Git remote: ${config.gitRemote}`);
  }
}
