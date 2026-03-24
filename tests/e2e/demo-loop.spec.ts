/**
 * Demo loop test — exercises the full @mention → task → feed cycle.
 * Run with: pnpm --filter @slice/tests exec playwright test demo-loop
 *
 * This test creates a task via @mention, verifies the Director acknowledges it,
 * checks the task API, and captures the result. It's both a functional test
 * and a demo recording source.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.join(__dirname, '..', '..', 'brand', 'screenshots');

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});

test('full @mention → task → response loop', async ({ page, request }) => {
  // 1. Navigate and dismiss onboarding
  await page.goto('/');
  const skipBtn = page.locator('button:has-text("Skip")');
  if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skipBtn.click();
    await page.waitForTimeout(500);
  }
  await page.waitForSelector('.post-card', { timeout: 5000 });

  // 2. Verify health endpoint
  const health = await request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  const healthData = await health.json();
  expect(healthData.status).toBe('ok');
  expect(healthData.components.feed).toBe('ok');
  expect(healthData.components.persistence).toBe('ok');

  // 3. Create a task via @mention
  const postRes = await request.post('/api/feed', {
    data: {
      content: '@director Plan a REST API with auth, rate limiting, and health checks',
      agentName: 'you',
      agentRole: 'human',
    },
  });
  expect(postRes.ok()).toBeTruthy();
  const post = await postRes.json();
  expect(post.id).toBeTruthy();
  expect(post.content).toContain('@director');

  // 4. Wait for Director's acknowledgment (comes via setTimeout 500ms server-side)
  await page.waitForTimeout(1500);

  // 5. Check that a task was created
  const tasksRes = await request.get('/api/tasks');
  expect(tasksRes.ok()).toBeTruthy();
  const tasks = await tasksRes.json();
  expect(tasks.length).toBeGreaterThan(0);
  const latestTask = tasks[tasks.length - 1];
  expect(latestTask.title).toBeTruthy();
  expect(latestTask.status).toBeTruthy();

  // 6. Check the feed for Director's response
  const feedRes = await request.get('/api/feed');
  expect(feedRes.ok()).toBeTruthy();
  const feed = await feedRes.json();
  const directorPosts = feed.filter((p: any) =>
    p.agentName === 'Director' && p.content.includes('Received')
  );
  expect(directorPosts.length).toBeGreaterThan(0);

  // 7. Screenshot the result
  await page.reload();
  await page.waitForSelector('.post-card', { timeout: 5000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'demo-loop.png'), type: 'png' });

  // 8. Test the Director DM endpoint
  const dmRes = await request.post('/api/dm/director', {
    data: { content: 'What tasks are in the queue?' },
  });
  expect(dmRes.ok()).toBeTruthy();
  const dmData = await dmRes.json();
  // Should have either a real AI response or a mock one
  expect(dmData.agentMessage || dmData.userMessage).toBeTruthy();

  // 9. Test task completion API
  if (latestTask.id) {
    const completeRes = await request.post(`/api/tasks/${latestTask.id}/complete`, {
      data: { result: 'API planned: 3 endpoints, JWT auth, express-rate-limit, /health returns component status' },
    });
    expect(completeRes.ok()).toBeTruthy();
    const completed = await completeRes.json();
    expect(completed.status).toBe('completed');
  }

  // 10. Verify task shows as completed
  const finalTasks = await request.get('/api/tasks');
  const finalData = await finalTasks.json();
  const completedTask = finalData.find((t: any) => t.id === latestTask.id);
  if (completedTask) {
    expect(completedTask.status).toBe('completed');
  }

  // 11. Final screenshot with completed task
  await page.reload();
  await page.waitForSelector('.post-card', { timeout: 5000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, 'demo-complete.png'), type: 'png' });
});

test('DM history persists across page refresh', async ({ page, request }) => {
  // Send a DM
  const dmRes = await request.post('/api/dm/director', {
    data: { content: 'Hello Director, status report please' },
  });
  expect(dmRes.ok()).toBeTruthy();

  // Fetch DM history
  const historyRes = await request.get('/api/dm/director');
  expect(historyRes.ok()).toBeTruthy();
  const history = await historyRes.json();
  expect(history.messages).toBeDefined();
  expect(history.messages.length).toBeGreaterThan(0);
});

test('WebSocket delivers real-time updates', async ({ page }) => {
  await page.goto('/');
  const skipBtn = page.locator('button:has-text("Skip")');
  if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skipBtn.click();
    await page.waitForTimeout(500);
  }
  await page.waitForSelector('.post-card', { timeout: 5000 });

  // Count current posts
  const initialCount = await page.locator('.post-card').count();

  // Post via API (should arrive via WebSocket)
  await page.evaluate(async () => {
    await fetch('/api/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'WebSocket delivery test',
        agentName: 'test-bot',
        agentRole: 'worker',
      }),
    });
  });

  // Wait for WebSocket to deliver it
  await page.waitForTimeout(1000);
  const newCount = await page.locator('.post-card').count();
  expect(newCount).toBeGreaterThan(initialCount);
});
