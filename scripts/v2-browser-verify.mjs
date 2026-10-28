import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Run against a confirmed live dev server. This script never starts or restarts it.
// Game state access is read-only. Every player action uses actual browser keys/UI.
const BASE = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const OUT = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/v2-browser';
const MAPS = ['courtyard', 'canal', 'market', 'switchback', 'portals'];
const manifestPath = process.env.GARDEN_SOURCE_MANIFEST;
const manifestBytes = manifestPath ? await readFile(manifestPath) : null;
const sourceSnapshot = manifestBytes
  ? {
      manifestPath,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
      capturedAt: JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')).capturedAt,
    }
  : null;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(10000);
const errors = [];
const results = [];
const screenshots = [];
const navigations = [];
const devServerMessages = [];
let failure = null;
let failureState = null;
let complete = false;
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) navigations.push({ url: frame.url(), at: Date.now() });
});
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
  if (message.text().startsWith('[vite]')) devServerMessages.push(message.text());
});
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
page.on('requestfailed', (request) =>
  errors.push(`${request.failure()?.errorText} ${request.url()}`),
);

const snapshot = () => page.evaluate(() => window.__garden.snapshot());
const status = () => page.evaluate(() => window.__garden.status());
const record = (name, evidence) => {
  results.push({ name, evidence });
  console.log('PASS', name, JSON.stringify(evidence));
};
const screenshot = async (name) => {
  const before = await snapshot();
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  const after = await snapshot();
  screenshots.push({
    path,
    phase: before.phase,
    map: before.arena.id,
    before: before.phaseTime,
    after: after.phaseTime,
  });
};
const hold = async (key, milliseconds) => {
  await page.keyboard.down(key);
  try {
    await page.waitForTimeout(milliseconds);
  } finally {
    await page.keyboard.up(key);
  }
};
const waitPhase = (phase, timeout = 10000) =>
  page.waitForFunction((expected) => window.__garden.snapshot().phase === expected, phase, {
    timeout,
  });
const pause = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__garden.status().screen === 'paused');
};
const resume = async () => {
  await page.getByRole('button', { name: '继续对局' }).click();
  await page.waitForFunction(() => window.__garden.status().screen === 'playing');
};
const returnToMenu = async () => {
  if ((await status()).screen !== 'paused') await pause();
  await page
    .getByRole('button', { name: '返回主菜单', exact: true })
    .filter({ visible: true })
    .click();
  await page.waitForFunction(() => window.__garden.status().screen === 'menu');
};
const startMap = async (map, rotation = 'fixed') => {
  await page.getByRole('button', { name: '同屏双人' }).click();
  await page.getByLabel('机器人数量').selectOption('0');
  await page.getByLabel('地图', { exact: true }).selectOption(map);
  await page.getByLabel('回合换图').selectOption(rotation);
  const preview = await snapshot();
  assert.equal(preview.arena.id, map, 'UI map selection must change the preview arena');
  await page.getByRole('button', { name: '进入花园' }).click();
  await waitPhase('countdown');
  return snapshot();
};
const waitEquipped = async () => {
  await page.waitForFunction(() => {
    const state = window.__garden.snapshot();
    return (
      state.phase === 'playing' &&
      state.weaponsGranted &&
      state.actors.every((actor) => actor.armed)
    );
  });
};

/** Axis-aligned feedback steering along an already inspected clear route. */
const moveUntil = async (key, axis, limit, comparison, timeout = 5000) => {
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(
      ({ axis, limit, comparison }) => {
        const state = window.__garden.snapshot();
        const actor = state.actors[0];
        if (state.phase !== 'playing' || !actor.alive) return false;
        return comparison === 'less' ? actor.position[axis] < limit : actor.position[axis] > limit;
      },
      { axis, limit, comparison },
      { timeout },
    );
  } finally {
    await page.keyboard.up(key);
  }
  await page.waitForTimeout(180);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  assert.equal(await page.title(), '回旋花园 · Boomerang Garden');
  assert.equal(
    await page.evaluate(() => typeof window.boomerangGarden?.session?.acquire),
    'function',
    'the playable application must expose its actual public SDK runtime',
  );
  assert.equal((await status()).frameErrors, 0);
  record('main application runs through the public SDK with no frame callback errors', {
    frameErrors: (await status()).frameErrors,
  });
  const options = await page
    .getByLabel('地图', { exact: true })
    .locator('option')
    .evaluateAll((items) => items.map((item) => item.value));
  assert.deepEqual(
    options.filter((id) => !id.startsWith('original-')),
    MAPS,
  );
  assert.equal(options.filter((id) => id.startsWith('original-')).length, 58);
  record('58 original scenes and five custom map IDs', options);
  await screenshot('menu');

  for (const map of MAPS) {
    const initial = await startMap(map);
    assert.equal(initial.actors.length, 2);
    assert.equal(initial.arena.id, map);
    assert.equal(initial.options.mapRotation, 'fixed');

    // Input may be held during intro, but authoritative player positions cannot move.
    const initialPositions = initial.actors.map((actor) => ({ ...actor.position }));
    await hold('d', 250);
    const locked = await snapshot();
    assert.equal(locked.phase, 'countdown');
    assert.deepEqual(
      locked.actors.map((actor) => actor.position),
      initialPositions,
    );
    assert(locked.actors.every((actor) => !actor.armed));

    if (map === 'courtyard') {
      await page.waitForFunction(() => {
        const s = window.__garden.snapshot();
        return s.phase === 'countdown' && s.phaseTime >= 1.05;
      });
      assert.match(await page.locator('#center').innerText(), /准备/);
      await screenshot('ready');
      await pause();
      const frozen = await snapshot();
      await page.waitForTimeout(100);
      const canvas = page.locator('canvas.game-canvas');
      const first = await canvas.screenshot();
      await page.waitForTimeout(400);
      const second = await canvas.screenshot();
      const still = await snapshot();
      assert.equal(still.time, frozen.time);
      assert.equal(still.phaseTime, frozen.phaseTime);
      const firstHash = createHash('sha256').update(first).digest('hex');
      const secondHash = createHash('sha256').update(second).digest('hex');
      assert.equal(
        secondHash,
        firstHash,
        'paused world and intro animation must remain visually frozen',
      );
      record('pause freezes authoritative time and rendered intro canvas', {
        phaseTime: frozen.phaseTime,
        time: frozen.time,
        canvasHash: firstHash,
      });
      await resume();
    }

    await waitPhase('playing');
    const go = await snapshot();
    assert(go.phaseTime < 0.35, 'observe the Go boundary before equipment is granted');
    assert.equal(go.weaponsGranted, false);
    assert(go.actors.every((actor) => !actor.armed));
    await page.waitForFunction(() => {
      const s = window.__garden.snapshot();
      return s.phase === 'playing' && s.phaseTime >= 0.95;
    });
    const beforeEquipment = await snapshot();
    assert(beforeEquipment.phaseTime < 1.2, 'equipment observation arrived after its test window');
    assert.equal(beforeEquipment.weaponsGranted, false);
    assert(beforeEquipment.actors.every((actor) => !actor.armed));
    await waitEquipped();
    const equipped = await snapshot();
    assert(equipped.phaseTime >= 1.2 - 1 / 60);
    assert(equipped.phaseTime < 1.6, 'equipment must appear promptly after the 1.2 s delay');
    record(`${map}: countdown lock, Go and delayed equipment`, {
      introPositions: initialPositions,
      goAt: go.phaseTime,
      unarmedAt: beforeEquipment.phaseTime,
      equippedAt: equipped.phaseTime,
      obstacles: equipped.arena.obstacles.length,
      pits: equipped.arena.pits.length,
      portals: equipped.arena.portals.length,
    });

    if (map === 'portals') {
      assert.equal(equipped.arena.portals.length, 4);
      const entry = equipped.arena.portals.find((portal) => portal.id === 'mint-west');
      const exit = equipped.arena.portals.find((portal) => portal.id === entry.exitId);
      assert(entry && exit);
      // Spawn (-9, 5.5) -> x=-7 -> north into mint-west. No world mutation or SDK teleport.
      await moveUntil('d', 'x', entry.position.x - 0.2, 'greater');
      const beforePortal = (await snapshot()).actors[0].position;
      await page.keyboard.down('w');
      try {
        await page.waitForFunction(() => window.__garden.snapshot().actors[0].position.x > 0);
      } finally {
        await page.keyboard.up('w');
      }
      const afterPortal = (await snapshot()).actors[0].position;
      assert(Math.hypot(afterPortal.x - exit.position.x, afterPortal.y - exit.position.y) < 2);
      record('portal map: real keyboard entry moves the player to its paired exit', {
        entry: entry.id,
        exit: exit.id,
        before: beforePortal,
        after: afterPortal,
      });
    } else {
      const beforeMovement = (await snapshot()).actors[0].position.x;
      await hold('d', 120);
      assert((await snapshot()).actors[0].position.x > beforeMovement + 0.05);
    }

    await page.keyboard.press('j');
    await page.waitForFunction(() => window.__garden.snapshot().actors[0].attackSerial > 0);
    await page.waitForTimeout(720);
    await hold('k', 280);
    await page.waitForTimeout(80);
    await screenshot(`${map}-playing`);
    const rendering = await status();
    assert.equal(rendering.frameErrors, 0);
    record(`${map}: real input and active WebGL rendering`, {
      ...rendering.render,
      frameErrors: rendering.frameErrors,
    });
    await returnToMenu();
  }

  await page.setViewportSize({ width: 960, height: 640 });
  const select = page.getByLabel('地图', { exact: true });
  await select.scrollIntoViewIfNeeded();
  await select.selectOption('portals');
  assert.equal((await snapshot()).arena.id, 'portals');
  await page.getByLabel('回合换图').selectOption('cycle');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const mapBox = await select.boundingBox();
  assert(mapBox && mapBox.x >= 0 && mapBox.x + mapBox.width <= 960);
  await screenshot('small-map-selection');
  record('960x640: map selection and rotation remain accessible without horizontal overflow', {
    mapBox,
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  // A complete round through physical controls validates automatic map rotation and resets.
  await startMap('courtyard', 'cycle');
  await waitPhase('playing');
  await waitEquipped();
  const roundOne = await snapshot();
  const edge = -roundOne.arena.halfWidth + 1.3;
  // The westward route at spawn y=3.8 is unobstructed. Dash off its outer water edge.
  await moveUntil('a', 'x', edge, 'less');
  await page.keyboard.down('a');
  try {
    await page.keyboard.press('l');
    await page.waitForFunction(() => !window.__garden.snapshot().actors[0].alive, undefined, {
      timeout: 3500,
    });
  } finally {
    await page.keyboard.up('a');
  }
  await waitPhase('roundEnd');
  const settled = await snapshot();
  assert.equal(settled.actors[1].score, 1);
  assert.equal(settled.winnerId, 1);
  await page.waitForFunction(() => {
    const s = window.__garden.snapshot();
    return s.phase === 'roundEnd' && s.phaseTime >= 1.58;
  });
  await screenshot('round-circle-wipe');
  await page.waitForFunction(() => {
    const s = window.__garden.snapshot();
    return s.phase === 'roundEnd' && s.phaseTime >= 2.4;
  });
  await screenshot('round-score');
  await page.waitForFunction(() => {
    const s = window.__garden.snapshot();
    return s.round === 2 && s.arena.id === 'canal';
  });
  const next = await snapshot();
  assert.equal(next.phase, 'countdown');
  assert.equal(next.actors[1].score, 1);
  assert(next.actors.every((actor) => actor.alive && !actor.armed));
  assert.equal(next.discs.length, 0);
  assert.equal(next.options.mapRotation, 'cycle');
  await waitPhase('playing');
  await waitEquipped();
  await screenshot('rotation-canal-round-two');
  record('actual completed round rotates courtyard to canal with fresh arena and retained score', {
    oldMap: settled.arena.id,
    newMap: next.arena.id,
    round: next.round,
    scores: next.actors.map((actor) => actor.score),
    allAlive: next.actors.every((actor) => actor.alive),
    oldProjectilesCleared: next.discs.length === 0,
  });

  assert.deepEqual(errors, []);
  assert.equal((await status()).frameErrors, 0);
  record('no browser errors or failed resources across all five maps and transitions', errors);
  complete = true;
} catch (error) {
  failure = String(error?.stack ?? error);
  failureState = await snapshot().catch(() => null);
  await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    `${OUT}/verification.json`,
    JSON.stringify(
      {
        complete,
        base: BASE,
        sourceSnapshot,
        method: 'Chrome, real keyboard/UI, read-only development snapshots',
        results,
        screenshots,
        navigations,
        devServerMessages,
        errors,
        failure,
        failureState,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
