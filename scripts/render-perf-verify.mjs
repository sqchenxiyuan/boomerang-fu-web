import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const base = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const out = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/weapon-perf/current';
const sourceRoot = resolve(process.env.GARDEN_SOURCE_ROOT ?? '.');
async function sourceHashes(directory = resolve(sourceRoot, 'src')) {
  const hashes = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await sourceHashes(path));
    else
      hashes[relative(sourceRoot, path).replaceAll('\\', '/')] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
  return hashes;
}
const sourceBefore = await sourceHashes();
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.goto(base);
await page.waitForFunction(() => window.boomerangGarden);
const report = await page.evaluate(async () => {
  window.boomerangGarden.destroy();
  document.body.innerHTML =
    '<div id="perf" style="position:relative;width:1280px;height:800px"></div>';
  const { createBrowserGame } = await import('/src/sdk/browser.ts');
  const { GameRenderer } = await import('/src/rendering/renderer.ts');
  const { createState } = await import('/src/simulation/state.ts');
  const values = (a) => {
    a.sort((x, y) => x - y);
    return {
      n: a.length,
      mean: a.reduce((s, x) => s + x, 0) / (a.length || 1),
      p50: a[Math.floor(a.length * 0.5)] ?? 0,
      p95: a[Math.floor(a.length * 0.95)] ?? 0,
      max: a.at(-1) ?? 0,
    };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const game = createBrowserGame(document.getElementById('perf'), {
    keyboard: false,
    hud: false,
    pauseOnBlur: false,
    match: { mode: 'local', bots: 2, scoreGoal: 100, seed: 41, mapId: 'courtyard' },
  });
  for (const a of game.session.getState().actors) game.session.useBot(a.id);
  let recording = false,
    last = 0;
  const intervals = [],
    draw = [],
    copies = [],
    calls = [],
    geometries = [],
    triangles = [];
  let events = 0;
  const sourceDraw = game.renderer.draw.bind(game.renderer);
  game.renderer.draw = (...args) => {
    const t = performance.now();
    sourceDraw(...args);
    if (recording) draw.push(performance.now() - t);
  };
  const sourceSnapshot = game.session.snapshot.bind(game.session);
  game.session.snapshot = () => {
    const t = performance.now();
    const result = sourceSnapshot();
    if (recording) copies.push(performance.now() - t);
    return result;
  };
  game.onFrame = (f) => {
    if (!recording) return;
    const now = performance.now();
    if (last) intervals.push(now - last);
    last = now;
    events += f.events.length;
    const s = game.stats().render;
    calls.push(s.calls);
    geometries.push(s.geometries);
    triangles.push(s.triangles);
  };
  const gl = game.canvas.getContext('webgl2'),
    ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'not exposed';
  await wait(3000);
  recording = true;
  await wait(12000);
  recording = false;
  const real = {
    frames: draw.length,
    events,
    frameIntervalMs: values(intervals),
    drawCpuMs: values(draw),
    snapshotCpuMs: values(copies),
    drawCalls: values(calls),
    geometries: values(geometries),
    triangles: values(triangles),
    status: game.stats(),
  };
  game.destroy();
  const state = createState({
    mode: 'local',
    bots: 2,
    difficulty: 'normal',
    seed: 41,
    scoreGoal: 100,
  });
  state.phase = 'playing';
  state.phaseTime = 10;
  state.time = 10;
  const renderer = new GameRenderer(document.getElementById('perf'), state);
  const stressDraw = [],
    stressIntervals = [],
    stressCalls = [],
    stressGeometry = [];
  let prev = 0;
  for (let i = 0; i < 240; i++) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    state.time = 10 + i / 60;
    state.phaseTime = 10 + i / 60;
    if (i % 6 === 0)
      renderer.events(
        state.actors.map((a, k) => ({
          type: ['explosion', 'deflect', 'pickup', 'dash'][(i / 6 + k) % 4],
          position: a.position,
          actorId: a.id,
          value: 2.5,
          power: k === 2 ? 'shield' : undefined,
        })),
      );
    const t = performance.now();
    renderer.draw(state, 1, state.time, 1 / 60, false);
    const ms = performance.now() - t;
    if (i >= 60) {
      if (prev) stressIntervals.push(now - prev);
      stressDraw.push(ms);
      const s = renderer.stats();
      stressCalls.push(s.calls);
      stressGeometry.push(s.geometries);
    }
    prev = now;
  }
  const stress = {
    frames: stressDraw.length,
    drawCpuMs: values(stressDraw),
    frameIntervalMs: values(stressIntervals),
    drawCalls: values(stressCalls),
    geometries: values(stressGeometry),
    end: renderer.stats(),
  };
  renderer.dispose();
  return {
    kind: 'Chrome headless WebGL on local host; bot gameplay and separate synthetic repeatable effect fixture',
    gpu,
    viewport: [1280, 800],
    dpr: 1,
    real,
    stress,
  };
});
report.errors = errors;
report.url = base;
report.measuredAt = new Date().toISOString();
report.sourceBefore = sourceBefore;
report.sourceAfter = await sourceHashes();
report.sourceStable = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
await writeFile(out + '/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, sourceBefore: undefined, sourceAfter: undefined }));
await browser.close();
if (errors.length || !report.sourceStable) process.exitCode = 1;
