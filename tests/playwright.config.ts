import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  webServer: {
    command: 'cd .. && SEED_DEMO=true OPENROUTER_API_KEY=test-key node apps/slice/dist/index.js',
    port: 8080,
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
    stdout: 'pipe',
  },
});
