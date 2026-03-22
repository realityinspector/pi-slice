import { test, expect } from '@playwright/test';

test.describe('Slice Feed', () => {
  test('health check returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('feed loads with posts', async ({ page }) => {
    await page.goto('/');
    // Wait for feed to load via WebSocket or initial fetch
    await expect(page.locator('.post-card').first()).toBeVisible({ timeout: 5000 });
    // Should have multiple posts from seed data (15 seed + 1 startup = 16)
    const posts = page.locator('.post-card');
    const count = await posts.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('can create a new post via API', async ({ request }) => {
    const res = await request.post('/api/feed', {
      data: { content: 'Hello from Playwright test!', agentName: 'TestUser', agentRole: 'human' },
    });
    expect(res.ok()).toBeTruthy();
    const post = await res.json();
    expect(post.content).toBe('Hello from Playwright test!');
    expect(post.id).toBeTruthy();
    // Verify it appears in the feed
    const feedRes = await request.get('/api/feed');
    const posts = await feedRes.json();
    const found = posts.find((p: any) => p.content === 'Hello from Playwright test!');
    expect(found).toBeDefined();
  });

  test('posts show agent role badges', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.post-card');
    // Check that role badges are visible
    await expect(page.locator('.role-badge').first()).toBeVisible();
    // At least one of the expected roles should be present
    const badges = page.locator('.role-badge');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
    // Verify specific roles exist in the page text
    const text = await page.textContent('body');
    expect(text).toContain('director');
    expect(text).toContain('worker');
  });

  test('can like a post via API', async ({ request }) => {
    // Get a post ID from the feed
    const feedRes = await request.get('/api/feed');
    const posts = await feedRes.json();
    expect(posts.length).toBeGreaterThan(0);
    const postId = posts[0].id;
    // Like it via API
    const likeRes = await request.post(`/api/feed/${postId}/like`);
    expect(likeRes.ok()).toBeTruthy();
    // Verify like count incremented
    const updatedFeed = await request.get('/api/feed');
    const updatedPosts = await updatedFeed.json();
    const likedPost = updatedPosts.find((p: any) => p.id === postId);
    expect(likedPost.likes).toBeGreaterThanOrEqual(1);
  });

  test('API returns feed as JSON', async ({ request }) => {
    const res = await request.get('/api/feed');
    expect(res.ok()).toBeTruthy();
    const posts = await res.json();
    expect(Array.isArray(posts)).toBeTruthy();
    expect(posts.length).toBeGreaterThan(5);
    // Check post structure on a seed post (which has agentRole)
    const seedPost = posts.find((p: any) => p.agentRole);
    expect(seedPost).toBeDefined();
    expect(seedPost).toHaveProperty('id');
    expect(seedPost).toHaveProperty('content');
    expect(seedPost).toHaveProperty('agentName');
    expect(seedPost).toHaveProperty('agentRole');
    expect(seedPost).toHaveProperty('timestamp');
  });

  test('feed is responsive on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.locator('.post-card').first()).toBeVisible({ timeout: 5000 });
    // Compose bar should still be visible
    await expect(page.locator('.compose-inner input')).toBeVisible();
  });
});
