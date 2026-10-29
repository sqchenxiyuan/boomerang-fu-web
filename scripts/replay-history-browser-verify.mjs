import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const url = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173/';
const out = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/replay-history';
await mkdir(out, { recursive: true });
const report = { ok: false, url, checks: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  // Use a reproducible match seed; this test exercises persistence, not random bot outcomes.
  await context.addInitScript(() => {
    const original = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (array) => {
      const result = original(array);
      if (array instanceof Uint32Array && array.length === 1) array[0] = 8751;
      return result;
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('.play-tools summary').click();
  assert(await page.locator('#auto-record').isChecked());
  await page.locator('[data-mode=bots]').click();
  await page.locator('#bots').selectOption('4');
  await page.locator('#map').selectOption('courtyard');
  await page.locator('#sudden-death').selectOption('30');
  await page.locator('#start').click();
  assert(await page.evaluate(() => !!window.boomerangGarden.session.recording));
  await page.evaluate(() => {
    const game = window.boomerangGarden;
    for (let i = 0; i < 90 && game.session.getState().phase !== 'matchEnd'; i++)
      game.session.step(600);
    if (game.session.getState().phase !== 'matchEnd') throw new Error('Bots did not finish');
  });
  await page.waitForFunction(
    () => document.querySelector('.history-entry small')?.textContent === '完整对局 · 已存本地',
  );
  const firstId = await page.locator('.history-entry').getAttribute('data-replay-id');
  const first = await page.evaluate(() => window.boomerangGarden.session.getRecording());
  report.checks.push('Default auto recording and completed-match persistence');
  await page.locator('#replay').click();
  await page.evaluate(() => window.boomerangGarden.session.step(300));
  await page.locator('#record-toggle').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.history-entry').length === 2 &&
      ![...document.querySelectorAll('.history-entry')].some((e) =>
        e.textContent.includes('保存中'),
      ),
  );
  report.checks.push('Second match does not overwrite the first');
  // Select an older match; downloading must use that selection, not getRecording().
  await page
    .locator('.history-entry')
    .filter({ has: page.locator('small', { hasText: '完整对局' }) })
    .click();
  assert.equal(
    await page.locator('.history-entry[aria-pressed=true]').getAttribute('data-replay-id'),
    firstId,
  );
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-recording').click();
  const download = await downloadPromise;
  await download.saveAs(`${out}/selected.bgr.gz`);
  assert.equal(
    JSON.parse(gunzipSync(await readFile(`${out}/selected.bgr.gz`))).finalHash,
    first.finalHash,
  );
  await page.locator('#watch-recording').click();
  await page.waitForFunction(
    (n) => window.boomerangGarden.playback?.durationTicks === n,
    first.durationTicks,
  );
  await page.evaluate(() => {
    const g = window.boomerangGarden;
    g.pause();
    g.seekReplay(g.playback.durationTicks);
  });
  assert.equal(await page.evaluate(() => window.boomerangGarden.stats().replayError), null);
  report.checks.push('Select older match, download it, replay it through the final checksum');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.play-tools summary').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 2);
  assert(await page.locator('#auto-record').isChecked());
  report.checks.push('Refresh restores both matches and auto-recording remains enabled');
  // Importing the same replay repeatedly keeps a single library entry.
  await page.locator('#replay-file').setInputFiles(`${out}/selected.bgr.gz`);
  await page.waitForFunction(() =>
    document.querySelector('#tools-status').textContent.includes('录像已载入'),
  );
  assert.equal(await page.locator('.history-entry').count(), 2);
  report.checks.push('Import deduplicates an existing replay');
  await page.locator('#playback-exit').click();
  await page.locator('#start').click();
  await page.evaluate(() => window.boomerangGarden.session.step(180));
  await page.keyboard.press('Escape');
  await page.locator('#pause-restart').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 3);
  await page.evaluate(() => window.boomerangGarden.session.step(220));
  await page.keyboard.press('Escape');
  await page.locator('#return-menu').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.history-entry').length === 4 &&
      ![...document.querySelectorAll('.history-entry')].some((e) =>
        e.textContent.includes('保存中'),
      ),
  );
  report.checks.push('Restart and return-to-menu archive unfinished match segments');
  // Auto recording can be disabled for the next match without removing existing history.
  await page.locator('#auto-record').uncheck();
  await page.locator('#start').click();
  assert.equal(await page.evaluate(() => window.boomerangGarden.session.recording), null);
  await page.locator('#record-toggle').click();
  await page.evaluate(() => window.boomerangGarden.session.step(180));
  await page.locator('#record-toggle').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.history-entry').length === 5 &&
      ![...document.querySelectorAll('.history-entry')].some((e) =>
        e.textContent.includes('保存中'),
      ),
  );
  assert(!(await page.locator('#tools-status').textContent()).includes('正在录制'));
  report.checks.push('Opt-out and manual recording both work');
  await page.screenshot({ path: `${out}/history-desktop.png` });
  // A second tab receives deletions while leaving its currently playing replay intact.
  const other = await context.newPage();
  other.on('pageerror', (error) => report.errors.push(error.message));
  await other.goto(url, { waitUntil: 'networkidle' });
  await other.locator('.play-tools summary').click();
  await other.waitForFunction(() => document.querySelectorAll('.history-entry').length === 5);
  await other.locator('.history-entry').last().click();
  await other.locator('#watch-recording').click();
  await other.waitForFunction(() => !!window.boomerangGarden.playback);
  await page.bringToFront();
  await page.locator('.history-entry').last().click();
  await page.locator('#delete-recording').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 4);
  await other.waitForFunction(() => document.querySelectorAll('.history-entry').length === 4);
  assert(await other.evaluate(() => !!window.boomerangGarden.playback));
  // Explicit import can restore a deleted clip, even though automatic capture still suppresses it.
  await page.locator('#replay-file').setInputFiles(`${out}/selected.bgr.gz`);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.history-entry').length === 5 &&
      ![...document.querySelectorAll('.history-entry')].some((e) =>
        e.textContent.includes('保存中'),
      ),
  );
  assert.equal(
    await page.locator('.history-entry[aria-pressed=true]').getAttribute('data-replay-id'),
    firstId,
  );
  await other.waitForFunction(() => document.querySelectorAll('.history-entry').length === 5);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.play-tools summary').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 5);
  report.checks.push('Explicit reimport restores a deleted replay and persists it across refresh');
  await page.locator('.history-entry').last().click();
  await page.locator('#delete-recording').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 4);
  await other.waitForFunction(() => document.querySelectorAll('.history-entry').length === 4);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.play-tools summary').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 4);
  report.checks.push(
    'Deletion persists across refresh and synchronizes tabs without stopping playback',
  );
  await page.setViewportSize({ width: 430, height: 850 });
  await page.screenshot({ path: `${out}/history-narrow.png` });
  const bounds = await page.locator('.play-tools').boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 431 && bounds.y + bounds.height <= 850);
  const empty = await page.evaluate(() => {
    const s = window.boomerangGarden.session;
    s.startRecording();
    return s.stopRecording();
  });
  assert.equal(empty.durationTicks, 0);
  await page.locator('#replay-file').setInputFiles({
    name: 'empty.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(empty)),
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.history-entry').length === 5 &&
      ![...document.querySelectorAll('.history-entry')].some((e) =>
        e.textContent.includes('保存中'),
      ),
  );
  assert.equal(await page.evaluate(() => window.boomerangGarden.playback?.status), 'ended');
  report.checks.push('Valid empty imported recordings remain selectable and persist in history');
  // Disabled persistence must retain a playable/downloadable clip for the current tab.
  const fallback = await browser.newContext();
  await fallback.addInitScript(() =>
    Object.defineProperty(window, 'indexedDB', {
      value: {
        open() {
          throw new Error('Storage disabled');
        },
      },
    }),
  );
  const temporary = await fallback.newPage();
  temporary.on('pageerror', (error) => report.errors.push(error.message));
  await temporary.goto(url, { waitUntil: 'networkidle' });
  await temporary.locator('.play-tools summary').click();
  await temporary.locator('#start').click();
  await temporary.evaluate(() => window.boomerangGarden.session.step(250));
  await temporary.locator('#record-toggle').click();
  await temporary.waitForFunction(() =>
    document.querySelector('.history-entry small')?.textContent.includes('仅本页'),
  );
  assert(await temporary.locator('#history-warning').isVisible());
  await temporary.locator('#watch-recording').click();
  await temporary.waitForFunction(() => !!window.boomerangGarden.playback);
  report.checks.push(
    'Unavailable storage falls back to playable in-tab history with a visible warning',
  );
  // Encoding failures must not leave a permanent "saving" entry or prevent deletion.
  const noCompression = await browser.newContext();
  await noCompression.addInitScript(() => {
    window.CompressionStream = class {
      constructor() {
        throw new Error('Compression unavailable');
      }
    };
  });
  const raw = await noCompression.newPage();
  raw.on('pageerror', (error) => report.errors.push(error.message));
  await raw.goto(url, { waitUntil: 'networkidle' });
  await raw.locator('.play-tools summary').click();
  await raw.locator('#start').click();
  await raw.evaluate(() => window.boomerangGarden.session.step(180));
  await raw.locator('#record-toggle').click();
  await raw.waitForFunction(() =>
    document.querySelector('.history-entry small')?.textContent.includes('仅本页'),
  );
  assert(await raw.locator('#history-warning').isVisible());
  await raw.locator('#watch-recording').click();
  await raw.waitForFunction(() => !!window.boomerangGarden.playback);
  await raw.locator('#delete-recording').click();
  await raw.waitForFunction(() => document.querySelectorAll('.history-entry').length === 0);
  report.checks.push('Compression failure preserves a playable and deletable temporary recording');
  assert.deepEqual(report.errors, []);
  assert.equal(await page.evaluate(() => window.boomerangGarden.stats().frameErrors), 0);
  report.ok = true;
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
