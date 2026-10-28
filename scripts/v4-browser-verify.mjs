import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

const base = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const out = 'test-results/v4-gameplay';
await mkdir(out, { recursive: true });
async function sources(dir = resolve('src')) {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await sources(path));
    else
      result[relative(process.cwd(), path)] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
  return result;
}
const before = await sources();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(20000);
const errors = [],
  checks = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const pass = (name, evidence = {}) => {
  checks.push({
    name,
    evidence,
    kind: 'real BrowserGame with public controls; no state injection',
  });
  console.log('PASS', name);
};
async function ready() {
  await page.waitForFunction(() => window.boomerangGarden.session.getState().weaponsGranted);
}
async function start(powers = []) {
  await page.evaluate((p) => {
    const game = window.boomerangGarden;
    window.v4Events = [];
    game.start({
      mode: 'local',
      bots: 0,
      mapId: 'courtyard',
      scoreGoal: 100,
      seed: 295,
      startingPowers: p,
      powerupPool: ['shield'],
      suddenDeathTime: 180,
    });
    game.session.acquire(1, 'stationary opponent');
  }, powers);
  await ready();
}
let failure;
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    window.v4Events = [];
    window.boomerangGarden.session.onEvent((e) => {
      if (e.type === 'game') window.v4Events.push(e.event);
    });
  });
  await page.getByRole('button', { name: '同屏双人' }).click();
  await page.locator('.powerup-guide summary').click();
  assert.equal(await page.locator('.powerup-catalog p').count(), 14);
  await page.selectOption('#power-1', 'extra');
  await page.selectOption('#power-2', 'multi');
  await page.selectOption('#power-3', 'fire');
  await page.locator('#practice-start').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/catalog.png` });
  await page.click('#practice-start');
  await page.waitForFunction(() => {
    const s = window.boomerangGarden.session.getState();
    return s.phase === 'playing' && !s.weaponsGranted;
  });
  assert((await page.locator('#abilities').innerText()).includes('自动发镖'));
  await ready();
  const equipped = await page.evaluate(() => ({
    state: window.boomerangGarden.session.getState(),
    events: window.v4Events,
  }));
  assert(equipped.state.actors.every((a) => a.heldDiscs === 2));
  assert.equal(equipped.events.filter((e) => e.type === 'equip').length, 2);
  assert((await page.locator('#toast').innerText()).includes('就绪'));
  pass('menu catalog, real loadout grants, 1.2s automatic equipment cue');
  await page.keyboard.down('k');
  await page.waitForTimeout(180);
  await page.keyboard.up('k');
  await page.waitForFunction(() => window.v4Events.some((e) => e.type === 'split'));
  assert.equal(await page.evaluate(() => window.v4Events.find((e) => e.type === 'split').value), 4);
  await page.waitForFunction(() =>
    window.boomerangGarden.session.getState().zones.some((z) => z.kind === 'fire'),
  );
  await page.screenshot({ path: `${out}/fire-multi.png` });
  pass('keyboard throw splits fire weapon into four fragments and creates real fire zones');

  await start(['controlled']);
  await page.keyboard.down('k');
  await page.waitForTimeout(100);
  await page.keyboard.up('k');
  await page.waitForTimeout(120);
  await page.keyboard.down('k');
  await page.keyboard.down('d');
  await page.waitForFunction(() => window.boomerangGarden.session.getState().actors[0].controlling);
  await page.waitForTimeout(250);
  const controlled = await page.evaluate(() => window.boomerangGarden.session.getState());
  assert(controlled.discs.length > 0);
  assert(controlled.discs[0].velocity.x > 0);
  await page.screenshot({ path: `${out}/controlled.png` });
  await page.keyboard.up('d');
  await page.keyboard.up('k');
  pass('held throw plus direction steers remote weapon');

  await start(['teleport']);
  await page.keyboard.down('w');
  await page.waitForTimeout(160);
  await page.keyboard.up('w');
  await page.keyboard.down('k');
  await page.waitForTimeout(160);
  await page.keyboard.up('k');
  await page.waitForTimeout(100);
  await page.keyboard.press('l');
  await page.waitForFunction(() =>
    window.v4Events.some((e) => e.type === 'teleport' && e.entityType === 'actor'),
  );
  pass('dash button teleports to a flying own weapon');

  await start(['disguise', 'decoy', 'wallDash']);
  await page.waitForFunction(() => window.boomerangGarden.session.getState().actors[0].disguised);
  await page.screenshot({ path: `${out}/disguise.png` });
  await page.keyboard.down('d');
  await page.keyboard.press('l');
  await page.keyboard.up('d');
  await page.waitForFunction(() => window.boomerangGarden.session.getState().decoys.length > 0);
  await page.screenshot({ path: `${out}/decoy.png` });
  pass('standing still disguises actor; first dash creates a real decoy');

  await start(['reverse']);
  assert(
    (await page.evaluate(() => window.boomerangGarden.session.getState().actors[0].reverseTime)) >
      0,
  );
  await page.waitForFunction(
    () => window.boomerangGarden.session.getState().actors[0].reverseTime === 0,
  );
  pass('negative effect expires after active simulation time');

  // Drive through public script control and the normal pickup path; never mutate a snapshot.
  await page.evaluate(async () => {
    const { findPath } = await import('/src/simulation/navigation.ts');
    const game = window.boomerangGarden;
    window.v4Events = [];
    game.start({
      mode: 'local',
      bots: 0,
      mapId: 'courtyard',
      seed: 295,
      startingPowers: [],
      powerupPool: ['ice'],
    });
    game.session.acquire(1, 'stationary opponent');
    game.session.useScript(
      0,
      ({ state, actorId }) => {
        const actor = state.actors.find((a) => a.id === actorId),
          pickup = state.pickups[0];
        if (!pickup) return {};
        const path = findPath(state.arena, actor.position, pickup.position);
        const goal =
          path.find((p) => Math.hypot(p.x - actor.position.x, p.y - actor.position.y) > 0.3) ??
          pickup.position;
        const dx = goal.x - actor.position.x,
          dy = goal.y - actor.position.y,
          d = Math.max(1, Math.hypot(dx, dy));
        return { move: { x: dx / d, y: dy / d } };
      },
      'walk to real pickup',
    );
  });
  await page.waitForFunction(() =>
    window.v4Events.some((e) => e.type === 'pickup' && e.power === 'ice' && e.actorId === 0),
  );
  pass('book spawns from selected pool and grants ice through physical collection');
  await page.evaluate(() => window.boomerangGarden.pause());
  const paused = await page.evaluate(() => window.boomerangGarden.session.getState());
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => window.boomerangGarden.session.getState()), paused);
  pass('pause freezes all simulation and item timers');
  assert.equal(await page.evaluate(() => window.boomerangGarden.stats().frameErrors), 0);
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(failure);
  await writeFile(
    `${out}/failure-state.json`,
    JSON.stringify(
      await page.evaluate(() => ({
        state: window.boomerangGarden?.session.getState(),
        events: window.v4Events,
      })),
      null,
      2,
    ),
  );
}
const after = await sources();
const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
await writeFile(
  `${out}/report.json`,
  JSON.stringify(
    { base, checks, errors, failure, before, after, changed, measuredAt: new Date().toISOString() },
    null,
    2,
  ),
);
await browser.close();
if (failure || errors.length || changed.length) {
  if (changed.length) console.error('Source changed during run:', changed);
  process.exitCode = 1;
}
