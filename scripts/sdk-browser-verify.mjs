import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const out = 'test-results/sdk-browser';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [],
  checks = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});
const pass = (name, detail = {}) => {
  checks.push({ name, ...detail });
  console.log(`PASS ${name}`);
};
const state = () => page.evaluate(() => window.sdkDemo.session.getState());
async function ready() {
  await page.waitForFunction(() => window.sdkDemo.session.getState().weaponsGranted, null, {
    timeout: 15000,
  });
  await page.waitForTimeout(70);
}
async function neutralOpponent() {
  await page.evaluate(() =>
    window.sdkDemo.session.acquire(1, 'stationary test opponent').release(),
  );
}
async function hold(selector, duration) {
  await page.locator(selector).hover();
  await page.mouse.down();
  await page.waitForTimeout(duration);
  await page.mouse.up();
}
try {
  await page.goto(`${base}/sdk-demo.html`, { waitUntil: 'networkidle' });
  await neutralOpponent();
  await ready();
  await page.evaluate(() => {
    window.eventsSeen = [];
    window.sdkDemo.session.onEvent((e) => {
      if (e.type === 'game') window.eventsSeen.push(e.event);
    });
  });
  await page.locator('#demo-external').click();
  let before = (await state()).actors[0].position;
  await hold('[data-move="right"]', 300);
  let after = (await state()).actors[0].position;
  assert(after.x - before.x > 0.5);
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'external',
  );
  pass('demo buttons inject external movement', { distance: after.x - before.x });
  await hold('[data-action="throw"]', 350);
  await page.waitForFunction(() => window.eventsSeen.some((e) => e.type === 'throw'));
  pass('external press and release throws a real disc');

  await page.locator('#demo-start').click();
  await neutralOpponent();
  await ready();
  const prior = (await state()).actors[0].position;
  await page.locator('#demo-script').click();
  await page.waitForTimeout(350);
  const scripted = (await state()).actors[0].position;
  assert(Math.hypot(scripted.x - prior.x, scripted.y - prior.y) > 0.3);
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'script',
  );
  await page.locator('#demo-human').click();
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'human',
  );
  before = (await state()).actors[0].position;
  await page.keyboard.down('s');
  await page.waitForTimeout(320);
  await page.keyboard.up('s');
  after = (await state()).actors[0].position;
  assert(after.y - before.y > 0.4);
  await page.locator('#demo-release').click();
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'script',
  );
  pass('plain JS example runs; real keyboard takeover restores script', {
    humanDistance: after.y - before.y,
  });
  await page.locator('#demo-pause').click();
  await page.screenshot({ path: `${out}/demo-takeover.png`, fullPage: true });
  const frozen = await page.evaluate(() => window.sdkDemo.session.snapshot().tick);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.sdkDemo.session.snapshot().tick), frozen);
  await page.locator('#demo-pause').click();
  await page.waitForTimeout(100);
  assert((await page.evaluate(() => window.sdkDemo.session.snapshot().tick)) > frozen);
  pass('demo pause and resume freeze and restart world ticks');

  await page.locator('#demo-start').click();
  await neutralOpponent();
  await ready();
  await page.evaluate(() => {
    window.eventsSeen = [];
    window.externalTest = window.sdkDemo.session.acquire(0, 'ttl test');
    window.externalTest.submit({ throw: true }, 18);
  });
  await page.waitForFunction(() => window.sdkDemo.session.getState().actors[0].charge > 0.1);
  await page.waitForTimeout(450);
  const expired = await state();
  assert.equal(expired.actors[0].charge, 0);
  assert.equal(expired.actors[0].armed, true);
  assert.equal(
    await page.evaluate(() => window.eventsSeen.filter((e) => e.type === 'throw').length),
    0,
  );
  await page.evaluate(() => {
    window.takeoverTest = window.sdkDemo.session.takeover(0, 0);
  });
  assert.equal(await page.evaluate(() => window.externalTest.active), false);
  const rejected = await page.evaluate(() => {
    try {
      window.externalTest.submit({ move: { x: 1, y: 0 } });
      return false;
    } catch {
      return true;
    }
  });
  assert(rejected);
  await page.evaluate(() => window.takeoverTest.release());
  assert.equal(
    await page.evaluate(() => window.sdkDemo.session.snapshot().controls[0].kind),
    'idle',
  );
  pass('external TTL cancels charge; human takeover revokes old lease');

  await page.evaluate(() => {
    window.sdkDemo.session.useHuman(0, 0);
    window.sdkDemo.canvas.focus();
  });
  await page.keyboard.down('k');
  await page.waitForFunction(() => window.sdkDemo.session.getState().actors[0].charge > 0.1);
  await page.keyboard.press('Escape');
  await page.keyboard.up('k');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(() => window.eventsSeen.filter((e) => e.type === 'throw').length),
    0,
  );
  assert.equal((await state()).actors[0].charge, 0);
  pass('keyboard charge paused and released never causes a phantom throw');
  assert.equal(await page.evaluate(() => window.sdkDemo.stats().frameErrors), 0);
  assert.equal(await page.evaluate(() => window.sdkDemo.session.snapshot().listenerErrors), 0);

  // Multiple SDK widgets share one document but have separate controls and clocks.
  await page.evaluate(async () => {
    window.sdkDemo.destroy();
    const { createBrowserGame } = await import('/src/sdk/browser.ts');
    document.body.innerHTML =
      '<div id="left" style="width:680px;height:540px;display:inline-block"></div><div id="right" style="width:680px;height:540px;display:inline-block"></div>';
    const options = { match: { mode: 'local', bots: 0, seed: 41 }, pauseOnBlur: false };
    window.leftGame = createBrowserGame(document.querySelector('#left'), options);
    window.rightGame = createBrowserGame(document.querySelector('#right'), options);
    window.makeWidget = createBrowserGame;
  });
  await page.waitForFunction(
    () =>
      window.leftGame.session.getState().weaponsGranted &&
      window.rightGame.session.getState().weaponsGranted,
  );
  await page.locator('#left canvas').click();
  const bothBefore = await page.evaluate(() =>
    [window.leftGame, window.rightGame].map((g) => g.session.getState().actors[0].position),
  );
  await page.keyboard.down('d');
  await page.waitForTimeout(300);
  await page.keyboard.up('d');
  const bothAfter = await page.evaluate(() =>
    [window.leftGame, window.rightGame].map((g) => g.session.getState().actors[0].position),
  );
  assert(bothAfter[0].x - bothBefore[0].x > 0.5);
  assert.deepEqual(bothAfter[1], bothBefore[1]);
  await page.locator('#right canvas').click();
  await page.waitForTimeout(300);
  const settledLeft = await page.evaluate(
    () => window.leftGame.session.getState().actors[0].position.x,
  );
  await page.keyboard.down('d');
  await page.waitForTimeout(300);
  await page.keyboard.up('d');
  const isolation = await page.evaluate(() =>
    [window.leftGame, window.rightGame].map((g) => g.session.getState().actors[0].position.x),
  );
  assert(isolation[1] - bothAfter[1].x > 0.5);
  assert(Math.abs(isolation[0] - settledLeft) < 0.1);
  await page.keyboard.press('Escape');
  assert.deepEqual(
    await page.evaluate(() =>
      [window.leftGame, window.rightGame].map((g) => g.session.snapshot().status),
    ),
    ['running', 'paused'],
  );
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${out}/two-instances.png` });
  pass('two browser instances isolate focused keyboard, movement and pause');

  const destroyed = await page.evaluate(() => {
    window.leftGame.session.destroy();
    return {
      frames: window.leftGame.stats().frames,
      tick: window.rightGame.session.snapshot().tick,
    };
  });
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#left canvas').count(), 0);
  assert.equal(await page.evaluate(() => window.leftGame.stats().frames), destroyed.frames);
  assert((await page.evaluate(() => window.rightGame.session.snapshot().tick)) > destroyed.tick);
  assert.equal(await page.evaluate(() => window.leftGame.session.snapshot().listenerErrors), 0);
  pass('session.destroy removes widget and halts its RAF without stopping sibling');

  await page.evaluate(() => {
    window.quietGame = window.makeWidget(document.querySelector('#left'), {
      match: { mode: 'local', bots: 0 },
      keyboard: false,
      pauseOnBlur: false,
    });
    window.quietGame.canvas.focus();
  });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.quietGame.session.snapshot().status), 'running');
  await page.waitForFunction(() => window.quietGame.session.getState().weaponsGranted);
  const quietBefore = await page.evaluate(
    () => window.quietGame.session.getState().actors[0].position,
  );
  await page.keyboard.down('d');
  await page.waitForTimeout(220);
  await page.keyboard.up('d');
  assert.deepEqual(
    await page.evaluate(() => window.quietGame.session.getState().actors[0].position),
    quietBefore,
  );
  pass('keyboard:false disables movement and keyboard system actions');
  await page.evaluate(() => {
    window.quietGame.session.onEvent((e) => {
      if (e.type === 'step') window.quietGame.destroy();
    });
  });
  await page.waitForFunction(() => window.quietGame.session.snapshot().status === 'disposed');
  const deadFrames = await page.evaluate(() => window.quietGame.stats().frames);
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.quietGame.stats().frames), deadFrames);
  assert.equal(await page.evaluate(() => window.quietGame.session.snapshot().listenerErrors), 0);
  await page.evaluate(() => window.rightGame.destroy());
  assert.equal(await page.locator('canvas').count(), 0);
  assert.deepEqual(
    await page.evaluate(() =>
      [window.leftGame, window.rightGame, window.quietGame].map((g) => g.stats().frameErrors),
    ),
    [0, 0, 0],
  );
  pass('destroy during step listener is safe and leaves no canvases or frame callbacks');
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/verification.json`,
    JSON.stringify(
      { passed: true, base, checks, errors, checkedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, errors }));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(
    `${out}/failure.json`,
    JSON.stringify({ error: String(error), checks, errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
