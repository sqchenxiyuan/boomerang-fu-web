import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = resolve(ROOT, 'test-results/sdk-package');
const INSTALL = resolve(WORK, 'consumer');
const BUILD = JSON.parse(await readFile(resolve(ROOT, 'dist-sdk/build-manifest.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(BUILD.tarball);
assert.equal(sha256(bytes), BUILD.sha256, 'The tarball must match the build manifest.');

function runNode(args, cwd = INSTALL) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function npmCli() {
  for (const path of [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean)) {
    try {
      await access(path);
      return path;
    } catch {
      /* Continue through known local npm locations. */
    }
  }
  throw new Error('Run npm run verify:sdk so npm_execpath is available.');
}

await mkdir(WORK, { recursive: true });
// Invalidate an older success before this run starts, including early failures.
await writeFile(
  resolve(WORK, 'verification.json'),
  `${JSON.stringify({ ok: false, status: 'running', startedAt: new Date().toISOString(), tarball: BUILD.tarball, sha256: BUILD.sha256 }, null, 2)}\n`,
);
if (
  dirname(INSTALL) !== WORK ||
  basename(INSTALL) !== 'consumer' ||
  dirname(WORK) !== resolve(ROOT, 'test-results')
)
  throw new Error('Invalid verification directory');
await rm(INSTALL, { recursive: true, force: true });
await mkdir(INSTALL, { recursive: true });
await writeFile(
  resolve(INSTALL, 'package.json'),
  JSON.stringify({ name: 'sdk-isolated-consumer', private: true, type: 'module' }),
);
runNode([
  await npmCli(),
  'install',
  BUILD.tarball,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  '--prefer-offline',
]);
const packageRoot = resolve(INSTALL, 'node_modules/@boomerang-garden/sdk');
assert.equal(
  await realpath(packageRoot),
  packageRoot,
  'The consumer must install actual package files, not a source symlink.',
);
const installed = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
assert.equal(installed.name, '@boomerang-garden/sdk');
assert.equal(installed.version, '0.6.0');
assert.ok(
  installed.exports['.'].types &&
    installed.exports['./browser'].types &&
    installed.exports['./types'].types,
);
const apiDocumentation = await readFile(resolve(packageRoot, 'docs/sdk-api.md'), 'utf8');
assert.equal(
  apiDocumentation,
  await readFile(resolve(ROOT, 'docs/sdk-api.md'), 'utf8'),
  'The installed package must contain the complete current API documentation.',
);
assert.ok(
  (await readFile(resolve(packageRoot, 'README.md'), 'utf8')).includes('(docs/sdk-api.md)'),
  'The package README must link to the included API documentation.',
);
for (const [source, hash] of Object.entries(BUILD.sourceHashes)) {
  assert.equal(sha256(await readFile(resolve(ROOT, source))), hash, `Source changed: ${source}`);
}

const probe = String.raw`
import assert from 'node:assert/strict';
// The core must import and run when DOM globals are forbidden, not merely absent.
const names = ['window', 'document', 'navigator'];
const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('Core touched DOM global: ' + name); } });
const { createSession, GameSession, ORIGINAL_MAPS, CUSTOM_MAPS, MAPS } = await import('@boomerang-garden/sdk');
assert.equal(typeof createSession, 'function');
assert.equal(typeof GameSession, 'function');
assert.equal(ORIGINAL_MAPS.length, 58);
assert.equal(CUSTOM_MAPS.length, 5);
assert.equal(MAPS.length, 63);
const original = createSession({ mapId: 'original-turn-teleportals', seed: 41, mode: 'local', bots: 0 });
original.step(240);
assert.equal(original.getState().arena.id, 'original-turn-teleportals');
assert(original.getState().arena.portals.length > 0);
assert(original.getState().arena.environment.mechanisms.some(m => m.kind === 'movingObstacle'));
original.destroy();
await import('@boomerang-garden/sdk/types');

function ready(session) {
  for (let i = 0; i < 1200; i++) {
    const state = session.getState();
    if (state.phase === 'playing' && state.weaponsGranted) return;
    session.step();
  }
  throw new Error('Session did not reach playable armed state.');
}
const session = createSession({ mapId: 'canal', seed: 41, bots: 1 });
assert.equal(session.status, 'running');
assert.equal(session.tick, 0);
assert.equal(session.getState().options.suddenDeathTime, 180);
session.acquire(1, 'idle opponent');
const external = session.acquire(0, 'node external controller');
const events = [];
const off = session.onEvent((event) => events.push(event));
ready(session);
const before = session.getState().actors[0].position.x;
external.submit({ move: { x: 1, y: 0 } }, 60);
session.step(10);
assert.ok(session.getState().actors[0].position.x > before + 0.1, 'External movement must change simulation position.');

external.submit({ throw: true }, 60);
session.step(12);
assert.ok(session.getState().actors[0].charge > 0.1, 'Held throw must charge.');
const throwsBeforeExpiry = events.filter((event) => event.type === 'game' && event.event.type === 'throw').length;
external.submit({ throw: true }, 1);
session.step(4);
assert.equal(session.getState().actors[0].charge, 0);
assert.equal(events.filter((event) => event.type === 'game' && event.event.type === 'throw').length, throwsBeforeExpiry, 'TTL expiry cancels charge; it must not synthesize a throw release.');

external.submit({ throw: true }, 60);
session.step(12);
external.submit({ throw: false }, 3);
session.step();
assert.ok(events.some((event) => event.type === 'game' && event.event.type === 'throw'), 'Explicit release must throw.');
const detached = session.getState();
detached.actors[0].position.x = 9999;
assert.notEqual(session.getState().actors[0].position.x, 9999, 'Public state snapshots must be detached.');
session.pause();
const paused = session.snapshot();
session.step(4);
assert.equal(session.getState().time, paused.state.time);
session.resume();
off();
session.destroy();
assert.equal(session.status, 'disposed');
assert.equal(session.tick, session.snapshot().tick);

const allPowers = ['shield','haste','explosive','wallDash','reverse','multi','teleport','fire','extra','ice','disguise','controlled','shrink','decoy'];
const pool = [...allPowers];
const starting = ['shield','extra','reverse'];
const configured = createSession({ mode: 'local', bots: 0, powerupPool: pool, startingPowers: starting });
pool.splice(0); starting.splice(0);
assert.deepEqual(configured.getState().options.powerupPool, allPowers);
assert.deepEqual(configured.getState().options.startingPowers, ['shield','extra','reverse']);
assert.ok(configured.getState().actors.every((actor) => !actor.armed && actor.powers.length === 0));
ready(configured);
assert.ok(configured.getState().actors.every((actor) => actor.shield && actor.heldDiscs === 2 && actor.reverseTime > 5));
const beforeBadOptions = configured.snapshot();
for (const bad of [{powerupPool:[]}, {powerupPool:['shield','shield']}, {powerupPool:['missing']}, {startingPowers:['shield','haste','extra','fire']}]) {
  assert.throws(() => configured.start(bad));
  assert.deepEqual(configured.snapshot(), beforeBadOptions);
}
configured.start({powerupPool:['shield'], startingPowers:[]});
ready(configured); configured.step(300);
assert.ok(configured.getState().pickups.length > 0);
assert.ok(configured.getState().pickups.every((pickup) => pickup.kind === 'shield'));
configured.destroy();

const handoff = createSession({ mapId: 'courtyard', seed: 98, bots: 1 });
handoff.acquire(1, 'idle opponent');
ready(handoff);
handoff.useScript(0, () => ({ move: { x: -1, y: 0 } }), 'move left');
const startX = handoff.getState().actors[0].position.x;
handoff.step(12);
assert.ok(handoff.getState().actors[0].position.x < startX);
const human = handoff.takeover(0, 0);
assert.equal(handoff.snapshot().controls.find((control) => control.actorId === 0).kind, 'human');
for (let i = 0; i < 24; i++) {
  handoff.submitHuman(0, { move: { x: 1, y: 0 }, attack: false, dash: false, throwHeld: false, throwReleased: false });
  handoff.step();
}
const afterHuman = handoff.getState().actors[0].position.x;
human.release();
assert.equal(handoff.snapshot().controls.find((control) => control.actorId === 0).kind, 'script');
handoff.step(24);
assert.ok(handoff.getState().actors[0].position.x < afterHuman, 'Releasing human takeover must resume the script.');
const stale = handoff.acquire(0, 'external to be replaced');
const humanAgain = handoff.takeover(0, 0);
assert.equal(stale.active, false);
try { stale.submit({ move: { x: 1, y: 0 } }, 60); } catch { /* Rejection and ignored stale handles are both safe. */ }
assert.equal(handoff.snapshot().controls.find((control) => control.actorId === 0).kind, 'human');
humanAgain.release();
assert.equal(handoff.snapshot().controls.find((control) => control.actorId === 0).kind, 'idle', 'Expired external ownership cannot be resurrected by releasing a takeover.');
handoff.destroy();

const shrinking = createSession({ mapId: 'market', seed: 41, mode: 'local', bots: 0, suddenDeathTime: 1 });
const shrinkEvents = [];
shrinking.onEvent((entry) => { if (entry.type === 'game') shrinkEvents.push(entry.event); });
for (let i = 0; i < 1800; i++) {
  shrinking.step();
  if (shrinking.getState().actors.some((actor) => actor.death?.variant === 'burst')) break;
}
const shrunkState = shrinking.getState();
assert.equal(shrinkEvents.filter((event) => event.type === 'boundary').length, 1);
assert.ok(shrunkState.boundary.halfSize.x < shrunkState.boundary.startHalfSize.x);
assert.ok(shrunkState.actors.some((actor) => actor.death?.cause === 'boundary' && actor.death.variant === 'burst'));
assert.ok(shrinkEvents.some((event) => event.type === 'death' && event.variant === 'burst' && event.direction));
shrinking.pause();
const deathSnapshot = shrinking.getState();
shrinking.step(60);
assert.deepEqual(shrinking.getState(), deathSnapshot);
shrinking.start();
assert.equal(shrinking.getState().boundary.phase, 'idle');
assert.ok(shrinking.getState().actors.every((actor) => !actor.death && !actor.outOfBounds && !actor.fall));
shrinking.destroy();

for (const name of names) {
  const descriptor = descriptors.get(name);
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}
const browser = await import('@boomerang-garden/sdk/browser');
assert.equal(typeof browser.createBrowserGame, 'function');
console.log(JSON.stringify({ ok: true, imports: ['core', 'types', 'browser'], coreWithoutDOM: true, externalMovement: true, chargeRelease: true, ttlCancelsCharge: true, detachedSnapshots: true, pause: true, script: true, humanTakeover: true, staleHandleRejected: true, rectangularBoundary: true, persistentDeath: true, statusAndTick: true, powerupOptionsCopiedAndValidated: true, startingGrants: true, restrictedPickupPool: true }));
`;
await writeFile(resolve(INSTALL, 'controls.mjs'), probe);
const controls = JSON.parse(runNode([resolve(INSTALL, 'controls.mjs')]).trim());
const match = JSON.parse(runNode([resolve(packageRoot, 'examples/node-bots.mjs')]).trim());

const coreTypes = `import { createSession, GameSession, ReplayPlayer, runAIMatch, createHttpAgent } from '@boomerang-garden/sdk';
import type { PowerupKind, DeathCause } from '@boomerang-garden/sdk';
import type { Action, ScriptContext, SessionSnapshot } from '@boomerang-garden/sdk/types';
const powers: PowerupKind[] = ['shield','haste','explosive','wallDash','reverse','multi','teleport','fire','extra','ice','disguise','controlled','shrink','decoy'];
const session: GameSession = createSession({ mapId: 'canal', seed: 41, suddenDeathTime: 30, powerupPool: powers, startingPowers: ['extra','controlled'] });
const status: SessionSnapshot['status'] = session.status;
const tick: number = session.tick;
const action: Action = { move: { x: 1, y: 0 }, throw: true };
session.acquire(0).submit(action, 6);
session.useScript(0, (context: ScriptContext): Action => ({ attack: context.tick % 60 === 0 }));
const snapshot: SessionSnapshot = session.snapshot();
const phase: 'idle' | 'shrinking' | 'settled' = snapshot.state.boundary.phase;
const deathVariant: 'slice' | 'squash' | 'water' | 'cliff' | 'burst' | undefined = snapshot.state.actors[0].death?.variant;
const deathCauses: DeathCause[] = ['weapon','explosion','fall','boundary','fire','telefrag'];
void phase; void deathVariant; void deathCauses; void status; void tick;
void snapshot;
session.startRecording({label:'typecheck'});
const recording = session.stopRecording();
if (recording) new ReplayPlayer(recording).seek(0);
void runAIMatch({agents:{0:(observation,signal)=>({attack:!signal.aborted && observation.tick%30===0})}});
void createHttpAgent('http://127.0.0.1:8787/action');
session.destroy();
`;
const browserTypes = `import { createBrowserGame } from '@boomerang-garden/sdk/browser';
const host = document.createElement('div');
const game = createBrowserGame(host, { match: { mapId: 'portals' }, keyboard: false, pauseOnBlur: false, onFrame: () => {} });
const calls: number = game.stats().render.calls;
const canvas: HTMLCanvasElement = game.canvas;
game.session.useBot(0);
game.configureAudio({music:0.5,sfx:0.8,muted:false});
game.setSpeed(4);
void calls; void canvas;
game.destroy();
`;
await writeFile(resolve(INSTALL, 'core-consumer.ts'), coreTypes);
await writeFile(resolve(INSTALL, 'browser-consumer.ts'), browserTypes);
for (const kind of ['core', 'browser']) {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: kind === 'core' ? ['ES2022'] : ['ES2022', 'DOM', 'DOM.Iterable'],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: [`${kind}-consumer.ts`],
  };
  const path = resolve(INSTALL, `tsconfig.${kind}.json`);
  await writeFile(path, JSON.stringify(config));
  runNode([resolve(ROOT, 'node_modules/typescript/bin/tsc'), '--project', path]);
}

// Load the installed browser entry with an ordinary import map, without Vite/source imports.
await writeFile(
  resolve(INSTALL, 'browser.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Installed SDK smoke test</title><style>body{margin:0;background:#203e32}#arena{width:960px;height:640px;margin:auto}</style><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script></head><body><div id="arena"></div><script type="module">import {createBrowserGame} from '/node_modules/@boomerang-garden/sdk/lib/browser.js'; window.packageGame=createBrowserGame(document.querySelector('#arena'),{match:{mapId:'portals',seed:41,powerupPool:['shield'],startingPowers:['extra','shield']},keyboard:true,pauseOnBlur:false});window.packageGame.session.acquire(1,'idle opponent');</script></body></html>`,
);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const path = resolve(INSTALL, `.${pathname}`);
    const within = relative(INSTALL, path);
    if (within.startsWith('..') || isAbsolute(within)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type':
        extname(path) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise((resolveListening, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListening);
});
const browserErrors = [],
  failedRequests = [];
let browser, browserResult;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(request.url()));
  await page.goto(`http://127.0.0.1:${server.address().port}/browser.html`);
  await page.waitForFunction(
    () => window.packageGame?.session.getState().weaponsGranted,
    undefined,
    {
      timeout: 15000,
    },
  );
  const initial = await page.evaluate(() => ({
    x: window.packageGame.session.getState().actors[0].position.x,
    stats: window.packageGame.stats(),
    map: window.packageGame.session.getState().arena.id,
    actor: window.packageGame.session.getState().actors[0],
  }));
  assert.ok(initial.stats.render.calls > 0 && initial.stats.render.triangles > 0);
  assert.equal(initial.map, 'portals');
  assert.equal(initial.actor.heldDiscs, 2);
  assert.equal(initial.actor.shield, true);
  await page.evaluate(async () => {
    const game = window.packageGame;
    const original = game.onFrame;
    game.onFrame = ({ state }) => {
      state.actors[0].score = 999;
      state.options.powerupPool.push('reverse');
    };
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    game.onFrame = original;
  });
  const detachedFrame = await page.evaluate(() => window.packageGame.session.getState());
  assert.equal(detachedFrame.actors[0].score, 0);
  assert.deepEqual(detachedFrame.options.powerupPool, ['shield']);
  await page.evaluate(() => {
    window.packageExternal = window.packageGame.session.acquire(0, 'browser external controller');
    window.packageExternal.submit({ move: { x: 1, y: 0 } }, 60);
  });
  await page.waitForFunction(
    (x) => window.packageGame.session.getState().actors[0].position.x > x + 0.3,
    initial.x,
  );
  const externalX = await page.evaluate(() => {
    window.packageExternal.submit({});
    return window.packageGame.session.getState().actors[0].position.x;
  });
  await page.evaluate(() =>
    window.packageGame.session.useScript(0, () => ({ move: { x: -1, y: 0 } }), 'move left'),
  );
  await page.waitForFunction(
    (x) => window.packageGame.session.getState().actors[0].position.x < x - 0.3,
    externalX,
  );
  const beforeHuman = await page.evaluate(() => {
    window.packageTakeover = window.packageGame.session.takeover(0, 0);
    const snapshot = window.packageGame.session.snapshot();
    return {
      position: snapshot.state.actors[0].position,
      kind: snapshot.controls.find((control) => control.actorId === 0).kind,
    };
  });
  assert.equal(beforeHuman.kind, 'human');
  await page.locator('#arena canvas').click();
  await page.keyboard.down('d');
  try {
    await page.waitForFunction(
      (x) => window.packageGame.session.getState().actors[0].position.x > x + 0.3,
      beforeHuman.position.x,
      { timeout: 3000 },
    );
  } finally {
    await page.keyboard.up('d');
  }
  await page.keyboard.down('s');
  try {
    await page.waitForFunction(
      (y) => window.packageGame.session.getState().actors[0].position.y > y + 0.3,
      beforeHuman.position.y,
      { timeout: 3000 },
    );
  } finally {
    await page.keyboard.up('s');
  }
  const afterHuman = await page.evaluate(() => {
    const position = window.packageGame.session.getState().actors[0].position;
    window.packageTakeover.release();
    return {
      position,
      kind: window.packageGame.session.snapshot().controls.find((control) => control.actorId === 0)
        .kind,
    };
  });
  assert.equal(afterHuman.kind, 'script');
  await page.waitForFunction(
    (x) => window.packageGame.session.getState().actors[0].position.x < x - 0.3,
    afterHuman.position.x,
  );
  await page.evaluate(() => window.packageGame.pause());
  const pausedTime = await page.evaluate(() => window.packageGame.session.getState().time);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.packageGame.session.getState().time), pausedTime);
  await page.evaluate(() => window.packageGame.resume());
  await page.waitForFunction(
    (time) => window.packageGame.session.getState().time > time,
    pausedTime,
  );
  await page.screenshot({ path: resolve(WORK, 'browser.png') });
  const errorCounts = await page.evaluate(() => ({
    frameErrors: window.packageGame.stats().frameErrors,
    listenerErrors: window.packageGame.session.snapshot().listenerErrors,
  }));
  assert.equal(errorCounts.frameErrors, 0, 'Browser frame callbacks must not hide errors.');
  assert.equal(errorCounts.listenerErrors, 0, 'Session event listeners must not hide errors.');
  const destroyed = await page.evaluate(() => {
    window.packageGame.destroy();
    return {
      canvases: document.querySelectorAll('#arena canvas').length,
      status: window.packageGame.session.snapshot().status,
    };
  });
  assert.equal(destroyed.canvases, 0);
  assert.equal(destroyed.status, 'disposed');
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(failedRequests, []);
  browserResult = {
    ok: true,
    installedBundle: true,
    detachedOnFrame: true,
    startingGrants: true,
    map: initial.map,
    renderCalls: initial.stats.render.calls,
    externalMovement: true,
    scriptMovement: true,
    humanKeyboardTakeover: true,
    takeoverKeys: ['d', 's'],
    humanMovement: {
      x: afterHuman.position.x - beforeHuman.position.x,
      y: afterHuman.position.y - beforeHuman.position.y,
    },
    releaseRestoresScript: true,
    pauseResume: true,
    destroyRemovesCanvas: true,
    ...errorCounts,
    screenshot: resolve(WORK, 'browser.png'),
    errors: browserErrors,
    failedRequests,
  };
} catch (error) {
  const failed = {
    ok: false,
    stage: 'installed-browser',
    verifiedAt: new Date().toISOString(),
    tarball: BUILD.tarball,
    sha256: BUILD.sha256,
    error: error.message,
    controls,
    completeMatch: match,
    browser: { errors: browserErrors, failedRequests },
  };
  await writeFile(resolve(WORK, 'verification.json'), `${JSON.stringify(failed, null, 2)}\n`);
  console.error(JSON.stringify(failed, null, 2));
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

const report = {
  ok: true,
  verifiedAt: new Date().toISOString(),
  node: process.version,
  tarball: BUILD.tarball,
  sha256: BUILD.sha256,
  installedAt: packageRoot,
  installedVersion: installed.version,
  apiDocumentation: { included: true, matchesSource: true, linkedFromReadme: true },
  sourceHashesMatch: true,
  coreRuntimeFiles: BUILD.coreRuntimeFiles,
  typeDeclarations: {
    nodeNextCoreWithoutDOM: true,
    nodeNextBrowser: true,
    publicTypesSubpath: true,
  },
  controls,
  completeMatch: match,
  browser: browserResult,
};
await writeFile(resolve(WORK, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
