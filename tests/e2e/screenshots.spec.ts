import { test } from '@playwright/test';
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
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

test.describe('Mobile Screenshots', () => {
  test('01 — feed with posts', async ({ page }) => {
    await page.goto('/');
    // Dismiss onboarding if present
    const skipBtn = page.locator('button:has-text("Skip")');
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    // Wait for feed to load
    await page.waitForSelector('.post-card', { timeout: 5000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, '01-feed.png'), type: 'png' });
  });

  test('02 — director DM tab', async ({ page }) => {
    await page.goto('/');
    const skipBtn = page.locator('button:has-text("Skip")');
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('.tab-bar', { timeout: 5000 });
    await page.click('.tab:has-text("Director")');
    await page.waitForTimeout(600);
    // Type a message to show the DM interface
    const input = page.locator('.dm-input input, .dm-compose input');
    if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
      await input.fill('Plan the auth refactor for our API');
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(outDir, '02-director-dm.png'), type: 'png' });
  });

  test('03 — agents tab', async ({ page }) => {
    await page.goto('/');
    const skipBtn = page.locator('button:has-text("Skip")');
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('.tab-bar', { timeout: 5000 });
    await page.click('.tab:has-text("Agents")');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, '03-agents.png'), type: 'png' });
  });

  test('04 — compose with @mention', async ({ page }) => {
    await page.goto('/');
    const skipBtn = page.locator('button:has-text("Skip")');
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('.post-card', { timeout: 5000 });
    // Focus compose and type @mention
    const input = page.locator('.compose-inner input');
    if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
      await input.fill('@director build rate limiting middleware');
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: path.join(outDir, '04-compose-mention.png'), type: 'png' });
  });

  test('05 — onboarding welcome', async ({ page }) => {
    // Use a fresh context so onboarding shows
    await page.goto('/');
    await page.waitForTimeout(800);
    // Onboarding should be visible on first load
    const modal = page.locator('.onboarding-modal, .onboarding-overlay');
    if (await modal.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.screenshot({ path: path.join(outDir, '05-onboarding.png'), type: 'png' });
    } else {
      // If no onboarding, take feed screenshot as fallback
      await page.screenshot({ path: path.join(outDir, '05-onboarding.png'), type: 'png' });
    }
  });

  test('06 — post detail with actions', async ({ page }) => {
    await page.goto('/');
    const skipBtn = page.locator('button:has-text("Skip")');
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('.post-card', { timeout: 5000 });
    // Click the first post's comment button to open detail
    const commentBtn = page.locator('.action-btn').first();
    if (await commentBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await commentBtn.click();
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: path.join(outDir, '06-post-detail.png'), type: 'png' });
  });
});
