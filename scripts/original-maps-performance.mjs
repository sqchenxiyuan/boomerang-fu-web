import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const out = 'test-results/original-maps';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1200, height: 820 },
  deviceScaleFactor: 1,
});
const errors = [],
  records = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    window.boomerangGarden.destroy();
    document.body.innerHTML = '<div id="performance-stage" style="position:fixed;inset:0"></div>';
    const { createBrowserGame } = await import('/src/sdk/browser.ts');
    window.mapRuntime = createBrowserGame(document.querySelector('#performance-stage'), {
      keyboard: false,
      hud: false,
      pauseOnBlur: false,
      match: { mapId: 'original-enclosed', mode: 'solo', bots: 3 },
    });
  });
  for (const id of [
    'original-washer',
    'original-four-cogs',
    'original-plants',
    'original-temple-garden',
    'original-trap-maze2',
  ]) {
    await page.evaluate((id) => {
      const game = window.mapRuntime;
      game.start({
        mapId: id,
        mode: 'solo',
        bots: 3,
        seed: 8751,
        scoreGoal: 100,
        suddenDeathTime: 180,
      });
      game.session.getState().actors.forEach((actor) => game.session.useBot(actor.id));
    }, id);
    await page.waitForTimeout(3800);
    await page.evaluate(() => {
      window.frameSamples = [];
      window.frameStart = performance.now();
      window.frameLast = window.frameStart;
      window.frameTick = window.mapRuntime.session.tick;
      window.mapRuntime.onFrame = () => {
        const now = performance.now();
        window.frameSamples.push(now - window.frameLast);
        window.frameLast = now;
      };
    });
    await page.waitForTimeout(8000);
    const record = await page.evaluate(() => {
      const game = window.mapRuntime;
      game.onFrame = () => {};
      const elapsed = performance.now() - window.frameStart;
      const samples = window.frameSamples.sort((a, b) => a - b);
      const percentile = (n) => samples[Math.floor((samples.length - 1) * n)];
      const state = game.session.getState();
      return {
        id: state.arena.id,
        elapsedMs: elapsed,
        frames: samples.length,
        averageFps: (samples.length * 1000) / elapsed,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: samples.at(-1),
        ticksAdvanced: game.session.tick - window.frameTick,
        round: state.round,
        phase: state.phase,
        stats: game.stats(),
      };
    });
    assert(record.ticksAdvanced >= 60, `${id}: simulation did not progress`);
    assert.equal(record.stats.frameErrors, 0);
    records.push(record);
    console.log(`${id}: ${record.averageFps.toFixed(1)} fps, p95 ${record.p95Ms.toFixed(1)} ms`);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/performance-report.json`,
    JSON.stringify(
      {
        kind: 'Headless Chrome, 1200x820, four SDK bots, 8s samples; machine-specific observation, not a hardware-independent FPS guarantee',
        records,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
