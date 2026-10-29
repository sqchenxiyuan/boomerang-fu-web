import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { ReplayPlayer } from '../dist-sdk/lib/index.js';
const url = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/v6/browser';
const numericalState = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'number' && !Number.isInteger(item) ? Number(item.toFixed(8)) : item,
    ),
  );
await mkdir(out, { recursive: true });
const report = { ok: false, url, errors: [], audio: {}, speeds: [] };
await writeFile(`${out}/report.json`, JSON.stringify(report));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('[data-mode=bots]').click();
  await page.locator('#start').click();
  await page.locator('.play-tools summary').click();
  await page.waitForFunction(() => window.boomerangGarden.session.tick > 240);
  const initial = await page.evaluate(() => ({
    controls: window.boomerangGarden.session.snapshot().controls,
    record: window.boomerangGarden.session.recording,
    stats: window.boomerangGarden.stats(),
  }));
  assert(initial.controls.every((c) => c.kind === 'bot'));
  assert(initial.record.ticks > 240);
  assert(initial.stats.audio.musicNotes > 0);
  assert(initial.stats.audio.effectEvents > 0);
  assert.equal(initial.stats.audio.contextState, 'running');
  report.audio.initial = initial.stats.audio;
  await page.screenshot({ path: `${out}/ai-playing.png` });
  await page.locator('#record-toggle').click();
  const data = await page.evaluate(() => window.boomerangGarden.session.getRecording());
  const player = new ReplayPlayer(data);
  player.step(data.durationTicks);
  report.browserToNode = { ticks: data.durationTicks, status: player.status };
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-recording').click();
  const download = await downloadPromise;
  await download.saveAs(`${out}/ui-replay.bgr.gz`);
  assert.equal(
    JSON.parse(gunzipSync(await readFile(`${out}/ui-replay.bgr.gz`))).finalHash,
    data.finalHash,
  );
  await page.locator('#watch-recording').click();
  await page.locator('#playback-toggle').click();
  const frozen = await page.evaluate(() => window.boomerangGarden.playback.tick);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.boomerangGarden.playback.tick), frozen);
  await page.keyboard.press('j');
  await page.keyboard.press('l'); // K is now a replay transport shortcut.
  assert.equal(await page.evaluate(() => window.boomerangGarden.playback.tick), frozen);
  for (const tick of [Math.floor(data.durationTicks * 0.7), 0, data.durationTicks]) {
    await page.locator('#playback-seek').evaluate((el, t) => {
      el.value = String(t);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, tick);
    assert.equal(await page.evaluate(() => window.boomerangGarden.playback.tick), tick);
  }
  await page.locator('#playback-toggle').click();
  await page.waitForFunction(
    () =>
      window.boomerangGarden.playback.tick > 0 &&
      window.boomerangGarden.playback.status === 'playing',
  );
  await page.locator('#playback-speed').selectOption('8');
  await page.waitForFunction(() => window.boomerangGarden.playback.status === 'ended', undefined, {
    timeout: 15000,
  });
  assert.equal(await page.evaluate(() => window.boomerangGarden.stats().replayError), null);
  await page.screenshot({ path: `${out}/replay-ended.png` });
  // Import a Node-generated replay while a new live recording is in progress.
  await page.locator('#playback-exit').click();
  await page.locator('#start').click();
  const nodeData = JSON.parse(gunzipSync(await readFile('test-results/v6/node-replay.bgr.gz')));
  await page.locator('#replay-file').setInputFiles('test-results/v6/node-replay.bgr.gz');
  await page.waitForFunction(
    (n) => window.boomerangGarden.playback?.durationTicks === n,
    nodeData.durationTicks,
  );
  await page.evaluate(() => {
    const g = window.boomerangGarden;
    g.pause();
    g.seekReplay(g.playback.durationTicks);
  });
  const imported = await page.evaluate(() => ({
    state: window.boomerangGarden.playback.getState(),
    stats: window.boomerangGarden.stats(),
  }));
  const nodePlayer = new ReplayPlayer(nodeData);
  nodePlayer.seek(nodeData.durationTicks);
  assert.deepEqual(numericalState(imported.state), numericalState(nodePlayer.getState()));
  await page.locator('.play-tools summary').click();
  const redownload = page.waitForEvent('download');
  await page.locator('#export-recording').click();
  const importedFile = await redownload;
  await importedFile.saveAs(`${out}/imported-download.bgr.gz`);
  assert.equal(
    JSON.parse(gunzipSync(await readFile(`${out}/imported-download.bgr.gz`))).finalHash,
    nodeData.finalHash,
  );
  // Failed import must leave the existing replay intact.
  await page.locator('#replay-file').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format":"broken"}'),
  });
  await page.waitForFunction(() =>
    document.querySelector('#tools-status').textContent.includes('无法载入'),
  );
  assert.equal(
    await page.evaluate(() => window.boomerangGarden.playback.durationTicks),
    nodeData.durationTicks,
  );
  report.nodeToBrowser = {
    ticks: nodeData.durationTicks,
    finalStateEqual: true,
    failedImportPreserved: true,
  };
  // The exact same replay must produce the same state at equal ticks at every speed.
  for (const speed of [1, 4, 8]) {
    await page.evaluate(
      ({ data, speed }) => {
        const g = window.boomerangGarden;
        g.loadReplay(data);
        g.setSpeed(speed);
        g.resume();
      },
      { data, speed },
    );
    const started = performance.now();
    await page.waitForFunction(
      () => window.boomerangGarden.playback.status === 'ended',
      undefined,
      { timeout: 20000 },
    );
    const final = await page.evaluate(() => ({
      state: window.boomerangGarden.playback.getState(),
      stats: window.boomerangGarden.stats(),
    }));
    assert.deepEqual(numericalState(final.state), numericalState(player.getState()));
    assert.equal(final.stats.replayError, null);
    report.speeds.push({
      requested: speed,
      actual: data.durationTicks / 60 / ((performance.now() - started) / 1000),
      equal: true,
    });
  }
  // Actual audio gain, pause/resume and mute behavior from the public adapter.
  await page.evaluate(() => {
    const g = window.boomerangGarden;
    g.start({ mode: 'bots', bots: 4, mapId: 'courtyard', seed: 8751, scoreGoal: 5 });
    g.setSpeed(8);
    g.configureAudio({ music: 1, sfx: 0, muted: false });
    g.unlockAudio();
  });
  await page.waitForTimeout(800);
  report.audio.musicOnly = await page.evaluate(() => window.boomerangGarden.stats().audio);
  assert(report.audio.musicOnly.level > 0);
  await page.evaluate(() => window.boomerangGarden.configureAudio({ muted: true }));
  await page.waitForFunction(() => window.boomerangGarden.stats().audio.level < 0.00001);
  report.audio.muted = await page.evaluate(() => window.boomerangGarden.stats().audio);
  assert(report.audio.muted.level < 0.00001);
  await page.evaluate(() => {
    window.boomerangGarden.configureAudio({ muted: false });
    window.boomerangGarden.pause();
  });
  await page.waitForFunction(() => {
    const audio = window.boomerangGarden.stats().audio;
    return !audio.active && audio.level < 0.00001;
  });
  report.audio.paused = await page.evaluate(() => window.boomerangGarden.stats().audio);
  assert.equal(report.audio.paused.active, false);
  assert(report.audio.paused.level < 0.00001);
  await page.evaluate(() => {
    window.boomerangGarden.resume();
    window.boomerangGarden.configureAudio({ music: 0, sfx: 1 });
  });
  await page.waitForTimeout(2000);
  const endStats = await page.evaluate(() => window.boomerangGarden.stats());
  assert.equal(endStats.audio.error, null);
  assert.equal(endStats.frameErrors, 0);
  report.audio.resumed = endStats.audio;
  report.audio.blur = await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    return window.boomerangGarden.stats().audio;
  });
  assert.equal(report.audio.blur.active, false, 'Blur silences audio without waiting for RAF');
  await page.setViewportSize({ width: 430, height: 850 });
  await page.screenshot({ path: `${out}/narrow.png` });
  const bounds = await page.locator('.play-tools').boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 431);
  assert.deepEqual(report.errors, []);
  report.ok = true;
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
