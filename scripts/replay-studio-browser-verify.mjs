import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { createSession, ReplayPlayer } from '../dist-sdk/lib/index.js';

const url = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/replay-studio';
await mkdir(out, { recursive: true });
const session = createSession({
  mode: 'bots',
  bots: 4,
  mapId: 'courtyard',
  mapRotation: 'cycle',
  seed: 8751,
  scoreGoal: 3,
  suddenDeathTime: 5,
});
session.startRecording({ label: '四人对战 · 回放工作台验证', checkpointInterval: 120 });
session.step(6000);
const data = session.stopRecording();
session.startRecording();
const empty = session.stopRecording();
session.destroy();
await writeFile(`${out}/match.bgr.gz`, gzipSync(JSON.stringify(data)));
const report = { ok: false, url, checks: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.boomerangGarden.setSpeed(4));
  await page.locator('#replay-file').setInputFiles(`${out}/match.bgr.gz`);
  await page.locator('#replay-studio').waitFor({ state: 'visible' });
  await page.evaluate(() => window.boomerangGarden.pause());
  await page.waitForFunction(
    () => window.boomerangGarden.replayTimeline?.status === 'ready',
    undefined,
    { timeout: 60000 },
  );
  assert.equal(await page.evaluate(() => window.boomerangGarden.speed), 1);
  assert.equal(await page.locator('.play-tools').getAttribute('open'), null);
  assert((await page.locator('#replay-events .event-death').count()) > 0);
  assert((await page.locator('#replay-round-select option').count()) > 1);
  report.checks.push(
    'Dedicated studio, background event index, auto-close library and playback speed isolation',
  );
  const seek = async (tick) => {
    await page.evaluate((value) => {
      const game = window.boomerangGarden;
      game.pause();
      game.seekReplay(value);
    }, tick);
    await page.waitForFunction(
      (value) => document.querySelector('#playback-seek').value === String(value),
      tick,
    );
  };
  await seek(700);
  await page.locator('#replay-frame-back').click();
  await page.waitForFunction(() => window.boomerangGarden.playback.tick === 699);
  assert.equal(await page.evaluate(() => window.boomerangGarden.playback.status), 'paused');
  await page.locator('#replay-frame-next').click();
  await page.waitForFunction(() => window.boomerangGarden.playback.tick === 700);
  await page.locator('canvas').focus();
  await page.keyboard.press('Comma');
  await page.waitForFunction(() => window.boomerangGarden.playback.tick === 699);
  const reference = new ReplayPlayer(data);
  reference.seek(699);
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(JSON.stringify(window.boomerangGarden.playback.getState())),
    ),
    JSON.parse(JSON.stringify(reference.getState())),
  );
  report.checks.push(
    'Exact previous/next frame, keyboard shortcut and state equality with Node replay',
  );
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.boomerangGarden.playback.status === 'playing');
  const slider = page.locator('#playback-seek');
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(150);
  const held = await page.evaluate(() => window.boomerangGarden.playback.tick);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.boomerangGarden.playback.tick), held);
  await page.mouse.up();
  await page.waitForFunction(() => window.boomerangGarden.playback.status === 'playing');
  await seek(300);
  await slider.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.value = '450';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.boomerangGarden.playback.tick === 450);
  await slider.dispatchEvent('pointercancel');
  await page.waitForFunction(() => window.boomerangGarden.playback.tick === 300);
  assert.equal(await page.evaluate(() => window.boomerangGarden.playback.status), 'paused');
  report.checks.push(
    'Live scrub preview pauses, resumes previous playback state, and pointer cancellation restores cursor',
  );
  await seek(800);
  await page.locator('#replay-set-a').click();
  await seek(860);
  await page.locator('#replay-set-b').click();
  await page.locator('#replay-loop-toggle').click();
  await page.locator('#playback-toggle').click();
  await page.waitForTimeout(1400);
  const loopTick = await page.evaluate(() => window.boomerangGarden.playback.tick);
  assert(loopTick >= 800 && loopTick < 860);
  assert.equal(await page.locator('#replay-loop-toggle').getAttribute('aria-pressed'), 'true');
  await page.locator('#playback-toggle').click();
  await page.locator('#replay-loop-clear').click();
  report.checks.push('A-B repeat wraps during real browser playback and can be cleared');
  await page.locator('#replay-filter').selectOption('death');
  const event = page.locator('#replay-events .replay-event').first();
  const eventTick = Number(await event.getAttribute('data-tick'));
  await event.click();
  await page.waitForFunction((tick) => window.boomerangGarden.playback.tick === tick, eventTick);
  assert.equal(await page.evaluate(() => window.boomerangGarden.playback.status), 'paused');
  const rounds = await page
    .locator('#replay-round-select option')
    .evaluateAll((elements) => elements.map((el) => el.value));
  await page.locator('#replay-round-select').selectOption(rounds[1]);
  await page.waitForFunction(
    (tick) => window.boomerangGarden.playback.tick === tick,
    Number(rounds[1]),
  );
  assert.equal(await page.locator('#result').isVisible(), false);
  report.checks.push(
    'Filtered event navigation and round selection seek exact ticks without a live-match result overlay',
  );
  await seek(200);
  const geometries = await page.evaluate(() => window.boomerangGarden.stats().render.geometries);
  for (let i = 0; i < 12; i++) await seek(i % 2 ? 200 : 220);
  assert(
    (await page.evaluate(() => window.boomerangGarden.stats().render.geometries)) <= geometries + 3,
  );
  report.checks.push('Repeated same-round seeks reuse GPU geometry');
  await page.locator('#replay-filter').selectOption('all');
  await seek(eventTick);
  await page.screenshot({ path: `${out}/studio-desktop.png` });
  await page.setViewportSize({ width: 430, height: 850 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/studio-narrow.png` });
  for (const selector of ['.stage', '#playback-controls', '.replay-inspector']) {
    const bounds = await page.locator(selector).boundingBox();
    assert(
      bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= 431 &&
        bounds.y + bounds.height <= 850,
      selector,
    );
  }
  report.checks.push('Desktop and narrow layouts keep canvas, events and transport in view');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#replay-file').setInputFiles({
    name: 'empty.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(empty)),
  });
  await page.waitForFunction(() => window.boomerangGarden.playback.durationTicks === 0);
  await page.waitForFunction(() => document.querySelector('#playback-seek').disabled);
  assert.equal(await page.locator('#replay-loop-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#replay-events .replay-event').count(), 1);
  report.checks.push(
    'Replacing a replay clears prior loop, markers and controls; empty recordings remain safe',
  );
  // A host can load through the SDK directly without knowing any UI lifecycle method.
  await page.evaluate((clip) => {
    window.boomerangGarden.loadReplay(clip);
    window.boomerangGarden.pause();
  }, data);
  await page.waitForFunction(() => window.boomerangGarden.replayTimeline?.status === 'ready');
  await page.waitForFunction(
    () => document.querySelectorAll('#replay-events .replay-event').length > 1,
  );
  assert((await page.locator('#replay-loop-label').textContent()).includes('01:'));
  report.checks.push(
    'Direct SDK load automatically refreshes the UI read model without a UI callback',
  );
  await page.locator('#playback-exit').click();
  await page.waitForFunction(() => !window.boomerangGarden.playback);
  assert.equal(await page.evaluate(() => window.boomerangGarden.speed), 4);
  assert(await page.locator('.play-tools').evaluate((el) => el.open));
  assert.equal(await page.locator('#replay-studio').isVisible(), false);
  await page.locator('#start').click();
  assert(await page.evaluate(() => !!window.boomerangGarden.session.recording));
  report.checks.push(
    'Exit restores live speed, opens history and preserves default recording on the next match',
  );
  assert.deepEqual(report.errors, []);
  assert.equal(await page.evaluate(() => window.boomerangGarden.stats().frameErrors), 0);
  report.ok = true;
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
