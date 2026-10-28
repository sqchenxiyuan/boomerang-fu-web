import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const BASE = new URL(process.env.GARDEN_SITE_URL ?? 'http://127.0.0.1:4173/').href.replace(
  /\/?$/u,
  '/',
);
const OUT = process.env.GARDEN_SMOKE_OUTPUT ?? 'test-results';
await mkdir(OUT, { recursive: true });
const files = await readdir('dist/assets');
for (const file of files.filter((name) => name.endsWith('.js'))) {
  const text = await readFile(`dist/assets/${file}`, 'utf8');
  assert(!text.includes('__garden'), `Debug hook leaked in ${file}`);
  assert(!text.includes('F:\\SteamLibrary'), `Original install path leaked in ${file}`);
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const errors = [],
  external = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('request', (request) => {
  if (!request.url().startsWith(BASE) && !request.url().startsWith('data:'))
    external.push(request.url());
});
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
try {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  assert.equal(await page.evaluate(() => typeof window.__garden), 'undefined');
  await page.screenshot({ path: `${OUT}/production-menu.png` });
  await page.getByRole('button', { name: '同屏双人' }).click();
  await page.getByRole('button', { name: '进入花园' }).click();
  await page.waitForFunction(() => window.boomerangGarden.session.getState().weaponsGranted);
  const startX = await page.evaluate(
    () => window.boomerangGarden.session.getState().actors[0].position.x,
  );
  await page.keyboard.down('d');
  try {
    await page.waitForFunction(
      (x) => window.boomerangGarden.session.getState().actors[0].position.x > x + 0.2,
      startX,
    );
  } finally {
    await page.keyboard.up('d');
  }
  await page.keyboard.press('j');
  await page.waitForTimeout(750);
  await page.keyboard.down('k');
  await page.waitForTimeout(450);
  await page.keyboard.up('k');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#hud').isVisible(), true);
  assert.equal(await page.locator('.score-card').count(), 2);
  assert.notEqual(await page.locator('#round-timer').innerText(), '00:00');
  await page.screenshot({ path: `${OUT}/production-game.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '继续对局' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '继续对局' }).click();
  assert.equal(await page.locator('#pause').isHidden(), true);
  assert.equal(await page.evaluate(() => window.boomerangGarden.stats().frameErrors), 0);
  assert.equal(
    await page.evaluate(() => window.boomerangGarden.session.snapshot().listenerErrors),
    0,
  );
  const gameTimer = await page.locator('#round-timer').innerText();
  await page.evaluate(() => window.boomerangGarden.destroy());
  assert.equal(
    await page.evaluate(() => window.boomerangGarden.session.snapshot().listenerErrors),
    0,
  );
  assert.equal(await page.locator('canvas').count(), 0);
  await page.goto(new URL('sdk-demo.html', BASE).href, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  assert.equal(
    await page.getByRole('link', { name: '返回游戏' }).evaluate((link) => link.href),
    BASE,
  );
  assert.equal(await page.evaluate(() => typeof window.__garden), 'undefined');
  await page.selectOption('#demo-map', 'portals');
  await page.locator('#demo-start').click();
  await page.evaluate(() => window.sdkDemo.session.acquire(1).release());
  await page.waitForFunction(() => window.sdkDemo.session.getState().weaponsGranted);
  await page.locator('#demo-script').click();
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'script',
  );
  await page.locator('#demo-human').click();
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'human',
  );
  await page.keyboard.down('d');
  await page.waitForTimeout(180);
  await page.keyboard.up('d');
  await page.locator('#demo-release').click();
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'script',
  );
  await page.locator('#demo-pause').click();
  await page.screenshot({ path: `${OUT}/production-sdk-demo.png`, fullPage: true });
  assert.equal(await page.evaluate(() => window.sdkDemo.stats().frameErrors), 0);
  assert.equal(await page.evaluate(() => window.sdkDemo.session.snapshot().listenerErrors), 0);
  assert.equal(await page.evaluate(() => window.sdkDemo.session.getState().arena.id), 'portals');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    JSON.stringify({
      passed: true,
      url: BASE,
      debugHookAbsent: true,
      externalRequests: external,
      errors,
      timer: gameTimer,
      sdkDemo: true,
    }),
  );
  await writeFile(
    `${OUT}/production-verification.json`,
    JSON.stringify(
      {
        passed: true,
        url: BASE,
        debugHookAbsent: true,
        sdkDemo: true,
        frameErrors: 0,
        listenerErrors: 0,
        externalRequests: external,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
