import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.screenshot({ path: 'test-results/menu.png' });
console.log('MENU', await page.evaluate(() => window.__garden?.status()));
await page.getByRole('button', { name: '进入花园' }).click();
await page.waitForTimeout(3300);
console.log(
  'START',
  await page.evaluate(() => ({
    state: window.__garden.snapshot().phase,
    actors: window.__garden
      .snapshot()
      .actors.map((a) => ({ id: a.id, position: a.position, alive: a.alive })),
  })),
);
await page.keyboard.down('d');
await page.waitForTimeout(500);
await page.keyboard.up('d');
await page.keyboard.down('k');
await page.waitForTimeout(700);
await page.keyboard.up('k');
await page.waitForTimeout(200);
await page.screenshot({ path: 'test-results/game.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.screenshot({ path: 'test-results/pause.png' });
console.log('END', await page.evaluate(() => window.__garden.status()));
await writeFile('test-results/browser-preview-errors.json', JSON.stringify(errors, null, 2));
console.log('ERRORS', JSON.stringify(errors));
await browser.close();
