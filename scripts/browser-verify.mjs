import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
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
const errors = [],
  results = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
const snapshot = () => page.evaluate(() => window.__garden.snapshot());
const status = () => page.evaluate(() => window.__garden.status());
const waitPhase = (phase) =>
  page.waitForFunction((p) => window.__garden.snapshot().phase === p, phase, { timeout: 10000 });
const record = (name, evidence) => {
  results.push({ name, evidence });
  console.log('PASS', name, JSON.stringify(evidence));
};
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};
const pause = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__garden.status().screen === 'paused');
};
const resume = async () => {
  await page.getByRole('button', { name: '继续对局' }).click();
  await page.waitForFunction(() => window.__garden.status().screen === 'playing');
};

try {
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'test-results/v1-menu.png' });
  assert.equal(await page.title(), '回旋花园 · Boomerang Garden');
  await page.getByRole('button', { name: '同屏双人' }).click();
  await page.getByRole('button', { name: '进入花园' }).click();
  await waitPhase('playing');
  const initial = await snapshot();
  await hold('d', 250);
  const moved = await snapshot();
  assert(moved.actors[0].position.x > initial.actors[0].position.x + 0.3);
  assert.equal(moved.actors[1].position.x, initial.actors[1].position.x);
  await hold('ArrowLeft', 250);
  const p2Moved = await snapshot();
  assert(p2Moved.actors[1].position.x < initial.actors[1].position.x - 0.3);
  record(
    'independent two-player keyboard movement',
    p2Moved.actors.map((a) => a.position),
  );

  await page.keyboard.press('j');
  await page.waitForFunction(() => window.__garden.snapshot().actors[0].attackSerial > 0);
  await page.waitForTimeout(700);
  const beforeDash = (await snapshot()).actors[0].position.x;
  await page.keyboard.press('l');
  await page.waitForFunction(() => window.__garden.snapshot().actors[0].dashCooldown > 0.2);
  await page.waitForTimeout(260);
  assert((await snapshot()).actors[0].position.x > beforeDash + 2);
  await page.keyboard.down('k');
  await page.waitForTimeout(650);
  const charge = (await snapshot()).actors[0].charge;
  assert(charge > 0.4);
  await page.keyboard.up('k');
  await page.waitForFunction(() => window.__garden.snapshot().discs.some((d) => d.ownerId === 0));
  record('melee, dash and charged release through real keys', {
    charge,
    disc: (await snapshot()).discs[0],
  });
  await page.waitForTimeout(150);
  await page.keyboard.down('k');
  await page.waitForFunction(() => window.__garden.snapshot().actors[0].armed, undefined, {
    timeout: 9000,
  });
  await page.keyboard.up('k');
  await page.waitForTimeout(150);
  assert.equal((await snapshot()).actors[0].armed, true);
  record('held recall catches without rethrow on release', true);

  await page.keyboard.down('k');
  await page.waitForTimeout(220);
  await pause();
  const pausedAt = (await snapshot()).time;
  await page.keyboard.up('k');
  await page.waitForTimeout(450);
  assert.equal((await snapshot()).time, pausedAt);
  await page.screenshot({ path: 'test-results/v1-paused.png' });
  await resume();
  await page.waitForTimeout(150);
  assert.equal((await snapshot()).discs.filter((d) => d.ownerId === 0).length, 0);
  record('pause freezes simulation and clears charged input', { pausedAt });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => window.__garden.status().screen === 'paused');
  await resume();
  record('window blur handler pauses', true);

  // Virtual browser Gamepad API: real input mapping, without claiming physical hardware testing.
  await page.evaluate(() => {
    window.virtualPad = {
      index: 0,
      connected: true,
      mapping: 'standard',
      id: 'Test Gamepad',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [window.virtualPad],
    });
  });
  const beforePad = (await snapshot()).actors[0].position.y;
  await page.evaluate(() => {
    window.virtualPad.axes[1] = 1;
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.virtualPad.axes[1] = 0;
    window.virtualPad.buttons[9].pressed = true;
  });
  await page.waitForFunction(() => window.__garden.status().screen === 'paused');
  assert((await snapshot()).actors[0].position.y > beforePad);
  await page.evaluate(() => {
    window.virtualPad.buttons[9].pressed = false;
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.virtualPad.buttons[9].pressed = true;
  });
  await page.waitForFunction(() => window.__garden.status().screen === 'playing');
  await page.evaluate(() => {
    window.virtualPad.buttons[9].pressed = false;
    delete navigator.getGamepads;
  });
  record('virtual gamepad axis and Start pause/resume', true);

  await pause();
  await page.getByRole('button', { name: '重新开始这场' }).click();
  await waitPhase('playing');
  await page.screenshot({ path: 'test-results/v1-local.png' });
  // Play five complete rounds through real keys: dash into a pool, awarding the other player a point.
  for (let round = 1; round <= 5; round++) {
    await waitPhase('playing');
    await page.keyboard.down('w');
    await page.waitForFunction(
      () => window.__garden.snapshot().actors[0].position.y < 0.1,
      undefined,
      { timeout: 4000 },
    );
    await page.keyboard.up('w');
    await page.waitForTimeout(160);
    await page.keyboard.down('a');
    await page.keyboard.press('l');
    await page.waitForTimeout(220);
    await page.keyboard.up('a');
    await page.waitForFunction(() => !window.__garden.snapshot().actors[0].alive, undefined, {
      timeout: 2500,
    });
    const roundState = await snapshot();
    assert.equal(roundState.actors[1].score, round);
    record(`browser round ${round} settles one point`, {
      phase: roundState.phase,
      scores: roundState.actors.map((a) => a.score),
    });
    if (round < 5)
      await page.waitForFunction((n) => window.__garden.snapshot().round > n, round, {
        timeout: 6000,
      });
  }
  await waitPhase('matchEnd');
  assert.equal((await snapshot()).matchWinnerId, 1);
  await page.getByRole('button', { name: '再来一场' }).waitFor({ state: 'visible' });
  await page.screenshot({ path: 'test-results/v1-victory.png' });
  await page.getByRole('button', { name: '再来一场' }).click();
  assert((await snapshot()).actors.every((a) => a.score === 0 && a.alive));
  record('match result and replay reset via UI', true);

  await pause();
  await page
    .getByRole('button', { name: '返回主菜单', exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole('button', { name: '单人挑战' }).click();
  await page.getByLabel('机器人数量').selectOption('3');
  await page.getByRole('button', { name: '进入花园' }).click();
  await waitPhase('playing');
  assert.equal((await snapshot()).actors.length, 4);
  await page.waitForTimeout(900);
  await pause();
  await page.setViewportSize({ width: 960, height: 640 });
  await resume();
  await page.screenshot({ path: 'test-results/v1-small.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  record('four-player setup and 960x640 viewport', {
    actors: (await snapshot()).actors.length,
    overflow,
    render: (await status()).render,
  });
  assert.deepEqual(errors, []);
  record('no browser errors or failed assets', errors);
} finally {
  await writeFile(
    'test-results/browser-verification.json',
    JSON.stringify({ results, errors }, null, 2),
  );
  await browser.close();
}
