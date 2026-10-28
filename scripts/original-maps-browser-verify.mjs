import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const base = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const out = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/original-maps';
const dataPath = 'src/core/original-map-data.json';
const bytes = await readFile(dataPath);
const data = JSON.parse(bytes);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const records = [],
  errors = [];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1200, height: 820 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    window.boomerangGarden.destroy();
    document.body.innerHTML = '<div id="original-stage" style="position:fixed;inset:0"></div>';
    const { createBrowserGame } = await import('/src/sdk/browser.ts');
    window.mapRuntime = createBrowserGame(document.querySelector('#original-stage'), {
      autoStart: false,
      keyboard: false,
      hud: false,
      pauseOnBlur: false,
      match: { mapId: 'original-enclosed', mode: 'local', bots: 0, seed: 811 },
    });
  });
  for (const { info } of data) {
    const started = Date.now();
    const state = await page.evaluate((id) => {
      const game = window.mapRuntime;
      game.start({ mapId: id, mode: 'local', bots: 0, seed: 811, scoreGoal: 5 });
      for (const actor of game.session.getState().actors) game.session.acquire(actor.id).release();
      game.session.step(240);
      game.pause();
      const s = game.session.getState();
      return {
        id: s.arena.id,
        time: s.time,
        phase: s.phase,
        tick: game.session.tick,
        floors: s.arena.floors.length,
        obstacles: s.arena.obstacles.length,
        mechanisms: s.arena.environment.mechanisms.length,
        poses: s.arena.environment.mechanisms.map((m) => ({
          id: m.id,
          position: m.position,
          angle: m.angle,
          phase: m.phase,
        })),
      };
    }, info.id);
    await page.waitForTimeout(120);
    await page.locator('#original-stage canvas').screenshot({ path: `${out}/${info.id}.png` });
    const stats = await page.evaluate(() => window.mapRuntime.stats());
    assert.equal(stats.frameErrors, 0, info.id);
    assert.equal(state.id, info.id);
    assert(state.floors > 0, info.id);
    const frozen = await page.evaluate(() => JSON.stringify(window.mapRuntime.session.getState()));
    await page.waitForTimeout(40);
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.mapRuntime.session.getState())),
      frozen,
      `${info.id} pause`,
    );
    records.push({ ...state, stats, elapsedMs: Date.now() - started });
    console.log(`PASS ${info.id}: ${stats.render.calls} calls / ${state.mechanisms} mechanisms`);
  }
  assert.equal(records.length, 58);
  assert.equal(hash(await readFile(dataPath)), hash(bytes), 'map data changed during verification');
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/browser-report.json`,
    JSON.stringify(
      {
        passed: true,
        kind: 'public SDK deterministic stepping and real WebGL rendering; not original-game runtime',
        dataSha256: hash(bytes),
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
