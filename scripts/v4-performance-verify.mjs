import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Read-only source profiling against an already-running server. Never builds,
// changes application sources, starts a server, or deploys anything.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const OUT = resolve(ROOT, process.env.GARDEN_PERF_OUTPUT ?? 'test-results/v4-performance');
const SAMPLE = Number(process.env.GARDEN_PERF_SAMPLE_MS ?? 6000);
const WARMUP = Number(process.env.GARDEN_PERF_WARMUP_MS ?? 1500);
const PROFILE = process.env.GARDEN_PERF_PROFILE !== '0';
const SOFTWARE = process.env.GARDEN_PERF_SOFTWARE === '1';
const CPU_PROFILE = process.env.GARDEN_PERF_CPU_PROFILE === '1';
const SCENARIOS = (
  process.env.GARDEN_PERF_SCENARIOS ??
  'main-preview,main-idle-four,main-bots-four,main-paused,sdk-hud-idle-four,sdk-script-four'
)
  .split(',')
  .filter(Boolean);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const summary = (values) => {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total,
    mean: total / values.length,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
    p99: sorted[Math.floor((sorted.length - 1) * 0.99)],
    max: sorted.at(-1),
  };
};
async function sourceHashes(directory = resolve(ROOT, 'src')) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await sourceHashes(path));
    else result[relative(ROOT, path).replaceAll('\\', '/')] = hash(await readFile(path));
  }
  return result;
}
const errors = [],
  checks = [],
  samples = [];
const beganAt = new Date().toISOString();
const initialHashes = await sourceHashes();
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.GARDEN_PERF_HEADLESS !== '0',
  args: SOFTWARE
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : [],
});
const browserCDP = await browser.newBrowserCDPSession();
const systemInfo = await browserCDP
  .send('SystemInfo.getInfo')
  .catch((error) => ({ error: error.message }));
let failure = null;

// Timing instrumentation is installed only in the separately-labelled profile
// pass. Baseline still observes public onFrame and a native RAF probe; it is not
// a zero-overhead hardware benchmark. No stacks or per-frame JSON are collected.
function installProbe(profile) {
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const probe = (window.__v4perf = {
    active: false,
    profile,
    nativeRAF,
    timings: {},
    dom: {},
    clones: {},
    frames: [],
    rafTimes: [],
    longTasks: [],
    events: {},
    phaseFrames: {},
    renderStats: [],
    drawDts: [],
  });
  const record = (name, elapsed) => (probe.timings[name] ??= []).push(elapsed);
  probe.record = record;
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.startTime >= probe.started && entry.startTime <= (probe.ended ?? Infinity))
          probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: 'longtask', buffered: false });
  }
  if (!profile) return;
  const clone = window.structuredClone;
  window.structuredClone = function (value, options) {
    if (!probe.active) return clone(value, options);
    const type =
      value?.arena && Array.isArray(value.actors)
        ? 'world'
        : `other:${value?.type ?? typeof value}`;
    const begin = performance.now();
    try {
      return clone(value, options);
    } finally {
      const elapsed = performance.now() - begin;
      (probe.clones[type] ??= []).push(elapsed);
      record('structuredClone', elapsed);
    }
  };
  window.requestAnimationFrame = function (callback) {
    return nativeRAF(function (time) {
      if (!probe.active) return callback(time);
      const begin = performance.now();
      try {
        return callback(time);
      } finally {
        record(`rafCallback:${callback.name || 'anonymous'}`, performance.now() - begin);
      }
    });
  };
  for (const [prototype, property] of [
    [Element.prototype, 'innerHTML'],
    [Node.prototype, 'textContent'],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    const previous = new WeakMap(),
      labels = new WeakMap();
    Object.defineProperty(prototype, property, {
      ...descriptor,
      set(value) {
        if (!probe.active) return descriptor.set.call(this, value);
        let label = labels.get(this);
        if (!label) {
          label =
            this.id ||
            this.className ||
            `${this.parentElement?.className || this.nodeName}:${this.parentElement ? [...this.parentElement.children].indexOf(this) : 0}`;
          labels.set(this, label);
        }
        const key = `${property}:${label}`;
        const entry = (probe.dom[key] ??= {
          count: 0,
          repeatedValue: 0,
          characters: 0,
          setterMs: 0,
        });
        entry.count++;
        if (previous.has(this) && previous.get(this) === value) entry.repeatedValue++;
        previous.set(this, value);
        entry.characters += typeof value === 'string' ? value.length : 0;
        const begin = performance.now();
        try {
          return descriptor.set.call(this, value);
        } finally {
          entry.setterMs += performance.now() - begin;
        }
      },
    });
  }
}

async function instrumentMethods(page) {
  return page.evaluate(async () => {
    const probe = window.__v4perf;
    if (!probe.profile) return { available: false, reason: 'baseline pass' };
    // Vite can retain cache-busting ?t= imports after another agent's edits.
    // Reuse the URL actually loaded by this document, so hooks target its live
    // classes instead of a second, unused module instance without that query.
    const moduleURL = (path) =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).pathname === path)
        .at(-1)?.name ?? path;
    const [{ GameSession }, { GameRenderer }, { View }] = await Promise.all([
      import(moduleURL('/src/sdk/session.ts')),
      import(moduleURL('/src/rendering/renderer.ts')),
      import(moduleURL('/src/ui/view.ts')),
    ]);
    for (const [prototype, name, label] of [
      [GameSession.prototype, 'step', 'sessionStep'],
      [GameSession.prototype, 'snapshot', 'sessionSnapshot'],
      [GameSession.prototype, 'getState', 'sessionGetState'],
      [GameRenderer.prototype, 'draw', 'rendererDraw'],
      [GameRenderer.prototype, 'events', 'rendererEvents'],
      [View.prototype, 'update', 'siteHudUpdate'],
    ]) {
      const original = prototype[name];
      prototype[name] = function (...args) {
        if (!probe.active) return original.apply(this, args);
        if (label === 'rendererDraw') probe.drawDts.push(args[3]);
        const begin = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          probe.record(label, performance.now() - begin);
        }
      };
    }
    return { available: true, kind: 'dev-module prototypes; synchronous inclusive wall times' };
  });
}

async function prepare(page, scenario) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.boomerangGarden);
  const isDev = await page.evaluate(() => !!window.__garden);
  if (scenario.startsWith('sdk-')) {
    if (!isDev)
      throw new Error('Direct SDK scenarios require the development source server (5173).');
    await page.evaluate(async () => {
      window.boomerangGarden.destroy();
      document.body.innerHTML = '<div id="v4-sdk-host"></div>';
      document.body.style.cssText = 'margin:0;overflow:hidden';
      const host = document.querySelector('#v4-sdk-host');
      host.style.cssText = 'position:fixed;inset:0';
      const { createBrowserGame } = await import('/src/sdk/browser.ts');
      window.__v4game = createBrowserGame(host, { pauseOnBlur: false, keyboard: false });
    });
  } else
    await page.evaluate(() => {
      window.__v4game = window.boomerangGarden;
    });
  if (scenario !== 'main-preview') {
    await page.evaluate((name) => {
      const game = window.__v4game;
      game.start({
        mode: 'local',
        bots: 2,
        difficulty: 'normal',
        mapId: 'courtyard',
        mapRotation: 'fixed',
        seed: 53,
        scoreGoal: 50,
        suddenDeathTime: 1000,
      });
      for (const actor of game.session.getState().actors) {
        if (name === 'main-bots-four') game.session.useBot(actor.id);
        else if (name === 'sdk-script-four')
          game.session.useScript(actor.id, () => ({}), 'performance idle script');
        else game.session.acquire(actor.id, 'performance idle').release();
      }
    }, scenario);
    await page.waitForFunction(() => window.__v4game.session.getState().phase === 'playing', null, {
      timeout: 15000,
    });
    if (scenario === 'main-paused') await page.evaluate(() => window.__v4game.pause());
  }
  const methods = isDev
    ? await instrumentMethods(page)
    : { available: false, reason: 'production bundle; global hooks only' };
  await page.waitForTimeout(WARMUP);
  return { isDev, methods };
}

async function capture(page, duration) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (CPU_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  const before = await cdp.send('Performance.getMetrics');
  const result = await page.evaluate(async (milliseconds) => {
    const probe = window.__v4perf,
      game = window.__v4game;
    const startSnapshot = game.session.snapshot();
    const originalFrame = game.onFrame;
    const canvas = game.canvas;
    const gl = canvas.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const environment = {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio,
      visibility: document.visibilityState,
      canvas: {
        width: canvas.width,
        height: canvas.height,
        cssWidth: canvas.clientWidth,
        cssHeight: canvas.clientHeight,
      },
      webgl: gl
        ? {
            vendor: debug
              ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
              : gl.getParameter(gl.VENDOR),
            renderer: debug
              ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER),
            version: gl.getParameter(gl.VERSION),
          }
        : null,
    };
    const beforeStats = game.stats();
    probe.started = performance.now();
    probe.active = true;
    game.onFrame = function (frame) {
      originalFrame(frame);
      if (!probe.active) return;
      probe.frames.push({
        at: performance.now(),
        dt: frame.dt,
        time: frame.state.time,
        phase: frame.state.phase,
        elapsed: frame.elapsed,
        alpha: frame.alpha,
      });
      probe.phaseFrames[frame.state.phase] = (probe.phaseFrames[frame.state.phase] ?? 0) + 1;
      for (const event of frame.events)
        probe.events[event.type] = (probe.events[event.type] ?? 0) + 1;
      if (probe.frames.length % 30 === 1) probe.renderStats.push(game.stats().render);
    };
    const poll = (time) => {
      if (!probe.active) return;
      probe.rafTimes.push(time);
      probe.nativeRAF(poll);
    };
    probe.nativeRAF(poll);
    await new Promise((done) => setTimeout(done, milliseconds));
    probe.ended = performance.now();
    probe.active = false;
    game.onFrame = originalFrame;
    const afterStats = game.stats(),
      endSnapshot = game.session.snapshot();
    // Give the long-task observer a turn to flush entries ending at capture end.
    await new Promise((done) => setTimeout(done, 0));
    return {
      durationMs: probe.ended - probe.started,
      environment,
      beforeStats,
      afterStats,
      start: {
        tick: startSnapshot.tick,
        status: startSnapshot.status,
        time: startSnapshot.state.time,
        phase: startSnapshot.state.phase,
        json: JSON.stringify(startSnapshot.state),
      },
      end: {
        tick: endSnapshot.tick,
        status: endSnapshot.status,
        time: endSnapshot.state.time,
        phase: endSnapshot.state.phase,
        json: JSON.stringify(endSnapshot.state),
      },
      frames: probe.frames,
      rafTimes: probe.rafTimes,
      timings: probe.timings,
      clones: probe.clones,
      dom: probe.dom,
      longTasks: probe.longTasks,
      events: probe.events,
      phaseFrames: probe.phaseFrames,
      renderStats: probe.renderStats,
      drawDts: probe.drawDts,
    };
  }, duration);
  const after = await cdp.send('Performance.getMetrics');
  if (CPU_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    result.cpuProfile = profile;
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map();
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const id = profile.samples[i];
      self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
    }
    result.cpuTopSelf = [...self]
      .map(([id, microseconds]) => ({
        ...nodes.get(id)?.callFrame,
        sampledSelfMs: microseconds / 1000,
      }))
      .sort((a, b) => b.sampledSelfMs - a.sampledSelfMs)
      .slice(0, 30);
  }
  const beforeMap = Object.fromEntries(before.metrics.map(({ name, value }) => [name, value]));
  result.cdp = Object.fromEntries(
    after.metrics
      .filter(({ name }) =>
        [
          'TaskDuration',
          'ScriptDuration',
          'LayoutDuration',
          'RecalcStyleDuration',
          'LayoutCount',
          'RecalcStyleCount',
          'JSHeapUsedSize',
          'Nodes',
          'Documents',
        ].includes(name),
      )
      .map(({ name, value }) => [
        name,
        { before: beforeMap[name], after: value, delta: value - beforeMap[name] },
      ]),
  );
  await cdp.detach();
  return result;
}

function reduceCapture(raw) {
  const intervals = raw.rafTimes.slice(1).map((time, index) => time - raw.rafTimes[index]);
  const frameIntervals = raw.frames.slice(1).map((frame, index) => frame.at - raw.frames[index].at);
  const stableState = raw.start.json === raw.end.json;
  delete raw.start.json;
  delete raw.end.json;
  return {
    ...raw,
    stableState,
    raf: {
      ...summary(intervals),
      over25ms: intervals.filter((x) => x > 25).length,
      over50ms: intervals.filter((x) => x > 50).length,
      over100ms: intervals.filter((x) => x > 100).length,
      meanHz: (intervals.length * 1000) / intervals.reduce((a, b) => a + b, 0),
    },
    browserFrame: summary(frameIntervals),
    callbackDtMs: summary(raw.frames.map((f) => f.dt * 1000)),
    drawDtMs: summary(raw.drawDts.map((dt) => dt * 1000)),
    timings: Object.fromEntries(
      Object.entries(raw.timings).map(([key, values]) => [key, summary(values)]),
    ),
    clones: Object.fromEntries(
      Object.entries(raw.clones).map(([key, values]) => [key, summary(values)]),
    ),
  };
}

try {
  for (const profile of PROFILE ? [false, true] : [false]) {
    for (const scenario of SCENARIOS) {
      const hashesBefore = await sourceHashes();
      const context = await browser.newContext({
        viewport: { width: 1100, height: 760 },
        deviceScaleFactor: 1,
      });
      await context.addInitScript(installProbe, profile);
      const page = await context.newPage();
      const scenarioErrors = [];
      page.on('pageerror', (error) => scenarioErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') scenarioErrors.push(message.text());
      });
      const setup = await prepare(page, scenario);
      const raw = await capture(page, SAMPLE);
      const result = {
        scenario,
        pass: CPU_PROFILE ? 'cpu-sampled' : profile ? 'profile' : 'baseline',
        ...setup,
        ...reduceCapture(raw),
        sourceHashes: hashesBefore,
      };
      if (result.cpuProfile) {
        result.cpuProfilePath = resolve(OUT, `${result.pass}-${scenario}.cpuprofile`);
        await writeFile(result.cpuProfilePath, JSON.stringify(result.cpuProfile));
        delete result.cpuProfile;
      }
      assert(result.frames.length >= 10, 'Too few frames for a meaningful sample');
      if (profile && setup.methods.available) {
        assert(
          result.timings.rendererDraw?.count >= result.frames.length,
          'Live renderer methods must be instrumented',
        );
        if (scenario.startsWith('main-'))
          assert(
            result.timings.siteHudUpdate?.count >= result.frames.length,
            'Live main-site HUD must be instrumented',
          );
      }
      if (scenario === 'main-paused') {
        assert(
          result.stableState && result.start.tick === result.end.tick,
          'Pause must freeze the public session state',
        );
        if (profile && setup.methods.available)
          assert(result.drawDtMs.max === 0, 'Paused renderer must receive zero dt');
        await page.evaluate(() => window.__v4game.resume());
        await page.waitForTimeout(250);
        const resumed = await page.evaluate(() => window.__v4game.session.snapshot().tick);
        assert(resumed > result.end.tick, 'Resume must advance the session');
        result.resumeTick = resumed;
      } else if (scenario !== 'main-preview')
        assert(result.end.tick > result.start.tick, 'Running session must advance naturally');
      const disposed = await page.evaluate(async () => {
        const game = window.__v4game;
        game.destroy();
        game.destroy();
        const frames = game.stats().frames;
        await new Promise((done) => setTimeout(done, 180));
        return {
          frames,
          after: game.stats().frames,
          canvasConnected: game.canvas.isConnected,
          huds: document.querySelectorAll('.garden-sdk-hud').length,
        };
      });
      assert.equal(disposed.frames, disposed.after);
      assert.equal(disposed.canvasConnected, false);
      assert.equal(disposed.huds, 0);
      result.dispose = disposed;
      result.errors = scenarioErrors;
      const hashesAfter = await sourceHashes();
      result.sourcesChangedDuringSample = [
        ...new Set([...Object.keys(hashesBefore), ...Object.keys(hashesAfter)]),
      ].filter((name) => hashesBefore[name] !== hashesAfter[name]);
      result.sourceStable = result.sourcesChangedDuringSample.length === 0;
      errors.push(...scenarioErrors.map((message) => `${result.pass}/${scenario}: ${message}`));
      samples.push(result);
      checks.push(
        `${result.pass}/${scenario}: natural frame progress, pause where applicable, and destroy cleanup`,
      );
      console.log(
        `${result.pass}/${scenario}: ${result.raf.meanHz.toFixed(1)} RAF Hz, p95 ${result.raf.p95.toFixed(2)} ms, >50 ms ${result.raf.over50ms}, ${result.clones.world?.count ?? 'unprofiled'} world clones, stable source=${result.sourceStable}`,
      );
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  await browser.close();
  const finalHashes = await sourceHashes();
  const report = {
    ok: !failure && errors.length === 0,
    beganAt,
    finishedAt: new Date().toISOString(),
    base: BASE,
    configuration: {
      sampleMs: SAMPLE,
      warmupMs: WARMUP,
      profile: PROFILE,
      cpuProfile: CPU_PROFILE,
      forcedSoftwareWebGL: SOFTWARE,
      scenarios: SCENARIOS,
      viewport: '1100x760, DPR 1',
    },
    measurementBoundaries: [
      'Real installed Chrome; actual GPU/backend is recorded per sample, not assumed from headless mode.',
      'Baseline has a lightweight native RAF probe and public onFrame recorder. Profile adds global clone/DOM/RAF hooks and dev prototype timing; compare like passes only.',
      'Timings are synchronous inclusive wall times, not exclusive CPU time. Nested methods overlap and must not be summed. WebGL submission time is not GPU completion time.',
      'Optional CPU profiles are separately labelled cpu-sampled. Sampling adds overhead; self samples are statistical and a single long pause cannot be assigned solely from this profile.',
      'RAF intervals describe callback cadence, not displayed monitor FPS or GPU frame latency; no target-FPS pass criterion is imposed.',
      'CDP Task/Script/Layout/RecalcStyle metrics cover the renderer process; deltas can include recording and CDP overhead, never GPU execution time.',
      'Global structuredClone classification distinguishes full world clones from event/other clones. No per-call stacks, serialization or deep comparisons occur inside the sampled frame.',
      'DOM repeatedValue counts compare values assigned by the hooked setter, not independently serialized live DOM. Setter duration excludes deferred layout/paint.',
      'Public controllers and natural RAF only; no manual Session.step or authoritative state mutation. No original-game runtime comparison.',
      'Per-sample source hashes detect concurrent edits; changed samples are diagnostic, not fixed-revision baselines. This script never writes src.',
      'Short local samples do not establish production/mobile/gamepad/network/long-soak performance or final installed SDK package performance.',
    ],
    systemInfo,
    initialHashes,
    finalHashes,
    sourcesChangedDuringRun: [
      ...new Set([...Object.keys(initialHashes), ...Object.keys(finalHashes)]),
    ].filter((name) => initialHashes[name] !== finalHashes[name]),
    checks,
    samples,
    errors,
    failure,
  };
  await writeFile(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${resolve(OUT, 'report.json')}`);
}
