import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const out = 'test-results/original-map-rendering/visual';
const ids = (
  process.env.GARDEN_MAP_IDS ??
  'original-enclosed,original-four-cogs,original-trap-maze2,original-teleportals,original-falling,original-raft-pair'
).split(',');
await mkdir(out, { recursive: true });
const errors = [],
  records = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 820 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    window.boomerangGarden.destroy();
    document.body.innerHTML = '<div id="map-stage" style="position:fixed;inset:0"></div>';
    const { createBrowserGame } = await import('/src/sdk/browser.ts');
    window.mapRuntime = createBrowserGame(document.querySelector('#map-stage'), {
      autoStart: false,
      keyboard: false,
      hud: false,
      pauseOnBlur: false,
      match: { mapId: 'original-enclosed', mode: 'local', bots: 0, seed: 811 },
    });
  });
  for (const id of ids) {
    for (const tick of [160, 340]) {
      const state = await page.evaluate(
        ({ id, tick }) => {
          const game = window.mapRuntime;
          game.start({ mapId: id, mode: 'local', bots: 0, seed: 811, scoreGoal: 5 });
          for (const actor of game.session.getState().actors)
            game.session.acquire(actor.id).release();
          game.session.step(tick);
          game.pause();
          const s = game.session.getState();
          return {
            id: s.arena.id,
            tick,
            time: s.time,
            phase: s.phase,
            actors: s.actors.map((a) => ({ id: a.id, alive: a.alive, position: a.position })),
          };
        },
        { id, tick },
      );
      await page.waitForTimeout(150);
      await page
        .locator('#map-stage canvas')
        .screenshot({ path: `${out}/${id}${tick === 160 ? '' : '-late'}.png` });
      const stats = await page.evaluate(() => window.mapRuntime.stats());
      assert.equal(stats.frameErrors, 0, id);
      assert.equal(state.id, id);
      records.push({ ...state, stats });
      console.log(`Captured ${id} tick ${tick}: ${stats.render.calls} draw calls`);
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        kind: 'WebGL representative-map visual review; not original runtime parity',
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
