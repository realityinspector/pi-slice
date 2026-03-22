import { test, expect } from '@playwright/test';
import path from 'path';

const screenshotDir = path.join(import.meta.dirname, '..', 'screenshots');

test.describe('Visual Review', () => {
  test('capture feed on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    // Dismiss onboarding if present
    const skipBtn = page.locator('.onboarding-skip');
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    // Wait for feed to load
    await page.waitForSelector('.post-card', { timeout: 5000 });
    await page.waitForTimeout(1000); // Let animations settle
    await page.screenshot({ path: path.join(screenshotDir, '01-feed-desktop.png'), fullPage: true });
  });

  test('capture feed on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const skipBtn = page.locator('.onboarding-skip');
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('.post-card', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(screenshotDir, '02-feed-mobile.png'), fullPage: true });
  });

  test('capture onboarding welcome', async ({ page }) => {
    // Clear localStorage to force onboarding
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('slice-onboarding-complete'));
    await page.reload();
    await page.waitForTimeout(1500);
    const overlay = page.locator('.onboarding-overlay');
    if (await overlay.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.screenshot({ path: path.join(screenshotDir, '03-onboarding.png') });
    }
  });

  test('capture director DM tab', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    // Clear onboarding
    await page.evaluate(() => localStorage.setItem('slice-onboarding-complete', 'true'));
    await page.reload();
    await page.waitForSelector('.post-card', { timeout: 5000 });
    await page.waitForTimeout(500);
    // Click Director tab
    const directorTab = page.locator('.tab').filter({ hasText: /Director/i });
    await directorTab.waitFor({ state: 'visible', timeout: 3000 });
    await directorTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(screenshotDir, '04-director-dm.png') });
  });

  test('capture agents tab', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('slice-onboarding-complete', 'true'));
    await page.reload();
    await page.waitForSelector('.post-card', { timeout: 5000 });
    await page.waitForTimeout(500);
    // Click Agents tab
    const agentsTab = page.locator('.tab').filter({ hasText: /Agents/i });
    await agentsTab.waitFor({ state: 'visible', timeout: 3000 });
    await agentsTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(screenshotDir, '05-agents-list.png') });
  });
});
