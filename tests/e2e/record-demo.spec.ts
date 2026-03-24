/**
 * Record demo GIF — captures frame-by-frame screenshots of the full
 * @mention → task → Director response loop, then stitches into a GIF.
 *
 * Run with: pnpm --filter @slice/tests exec playwright test record-demo
 * Then: cd brand && ffmpeg -framerate 2 -i demo-frames/frame-%03d.png -vf "scale=390:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" demo.gif
 */
import { test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const framesDir = path.join(__dirname, '..', '..', 'brand', 'demo-frames');

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});

test('record demo frames', async ({ page, request }) => {
  // Ensure frames directory
  fs.mkdirSync(framesDir, { recursive: true });
  let frame = 0;
  const snap = async () => {
    await page.screenshot({
      path: path.join(framesDir, `frame-${String(frame++).padStart(3, '0')}.png`),
      type: 'png'
    });
  };

  // Frame 0-1: Landing with feed
  await page.goto('/');
  const skipBtn = page.locator('button:has-text("Skip")');
  if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skipBtn.click();
    await page.waitForTimeout(500);
  }
  await page.waitForSelector('.post-card', { timeout: 5000 });
  await page.waitForTimeout(500);
  await snap(); // 0: feed loaded
  await snap(); // 1: hold

  // Frame 2-3: Focus compose bar and type @mention
  const input = page.locator('.compose-inner input');
  await input.click();
  await page.waitForTimeout(300);
  await snap(); // 2: compose focused

  await input.fill('@director Plan API with auth and rate limiting');
  await page.waitForTimeout(300);
  await snap(); // 3: typed @mention

  // Frame 4: Click send
  await page.locator('.compose-inner button').click();
  await page.waitForTimeout(300);
  await snap(); // 4: sent

  // Frame 5-6: Wait for Director response (comes via WebSocket)
  await page.waitForTimeout(1500);
  await snap(); // 5: Director acknowledged
  await snap(); // 6: hold

  // Frame 7-8: Switch to Director DM tab
  await page.click('.tab:has-text("Director")');
  await page.waitForTimeout(800);
  await snap(); // 7: Director DM view
  await snap(); // 8: hold

  // Frame 9: Type in DM
  const dmInput = page.locator('input[placeholder]').last();
  if (await dmInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await dmInput.fill('What tasks are queued?');
    await page.waitForTimeout(300);
    await snap(); // 9: DM with typed message
  } else {
    await snap(); // 9: fallback
  }

  // Frame 10-11: Switch to Agents tab
  await page.click('.tab:has-text("Agents")');
  await page.waitForTimeout(800);
  await snap(); // 10: Agents list
  await snap(); // 11: hold

  // Frame 12-13: Back to feed with the new posts
  await page.click('.tab:has-text("Feed")');
  await page.waitForTimeout(500);
  await snap(); // 12: feed with Director response visible
  await snap(); // 13: hold for ending

  // Frame 14-15: Extra hold frames for loop pause
  await snap(); // 14
  await snap(); // 15
});
