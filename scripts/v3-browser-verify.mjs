import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Development-server verification only: never builds or restarts the server.
// Real sessions use public controls and their own RAF. Synthetic states belong
// only to an isolated presentation fixture; they are not gameplay evidence.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const OUT = resolve(ROOT, process.env.GARDEN_TEST_OUTPUT ?? 'test-results/v3-feedback');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = [],
  screenshots = [],
  errors = [],
  serverMessages = [];
const beganAt = new Date().toISOString();
let failure = null;

async function sources(directory = resolve(ROOT, 'src')) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await sources(path));
    else result[relative(ROOT, path).replaceAll('\\', '/')] = hash(await readFile(path));
  }
  return result;
}
const initialSources = await sources();
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1100, height: 760 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
  if (message.text().startsWith('[vite]')) serverMessages.push(message.text());
});
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
page.on('requestfailed', (request) =>
  errors.push(`${request.failure()?.errorText} ${request.url()}`),
);
const pass = (name, evidenceKind, evidence = {}) => {
  checks.push({ name, evidenceKind, evidence });
  console.log('PASS', name);
};
async function shot(name, evidenceKind) {
  const path = resolve(OUT, `${name}.png`);
  const bytes = await page.locator('#v3-arena canvas').screenshot({ path });
  const entry = { name, evidenceKind, path, sha256: hash(bytes) };
  screenshots.push(entry);
  return entry.sha256;
}
async function comparePixels(firstName, secondName) {
  const encoded = await Promise.all(
    [firstName, secondName].map(async (name) =>
      (await readFile(resolve(OUT, `${name}.png`))).toString('base64'),
    ),
  );
  const comparison = await page.evaluate(async ([first, second]) => {
    async function decode(encoded) {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      bitmap.close();
      return pixels;
    }
    const [a, b] = await Promise.all([decode(first), decode(second)]);
    let changedPixels = 0,
      maxDelta = 0;
    for (let index = 0; index < a.length; index += 4) {
      let changed = false;
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(a[index + channel] - b[index + channel]);
        maxDelta = Math.max(maxDelta, delta);
        changed ||= delta !== 0;
      }
      if (changed) changedPixels++;
    }
    return { changedPixels, pixels: a.length / 4, maxDelta };
  }, encoded);
  // A few ±1 channel values can differ between identical WebGL frames. This
  // tolerance is below .005% of the canvas and cannot hide visible animation.
  assert(
    comparison.maxDelta <= 1 && comparison.changedPixels / comparison.pixels <= 0.00005,
    `Rendered frames differ: ${JSON.stringify(comparison)}`,
  );
  return comparison;
}
async function frame() {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}
async function shell(title) {
  await page.evaluate((label) => {
    window.boomerangGarden?.destroy();
    window.v3?.game?.destroy();
    window.v3?.renderer?.dispose();
    document.body.innerHTML = '<div id="v3-heading"></div><div id="v3-arena"></div>';
    document.body.style.cssText = 'margin:0;background:#203e32;color:#fff7e0;font:16px system-ui';
    const heading = document.querySelector('#v3-heading');
    heading.textContent = label;
    heading.style.cssText = 'padding:12px 24px;height:24px';
    document.querySelector('#v3-arena').style.cssText =
      'width:1024px;height:680px;margin:auto;position:relative';
    window.v3 = {};
  }, title);
}

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.boomerangGarden);
  await shell('V3: public Session / natural short sudden-death match');
  await page.evaluate(async () => {
    const { createBrowserGame } = await import('/src/sdk/browser.ts');
    const game = createBrowserGame(document.querySelector('#v3-arena'), {
      match: {
        mapId: 'portals',
        seed: 41,
        mode: 'local',
        bots: 0,
        scoreGoal: 1,
        suddenDeathTime: 1,
      },
      pauseOnBlur: false,
      keyboard: true,
    });
    window.v3.game = game;
    window.v3.events = [];
    game.session.onEvent((entry) => {
      if (entry.type === 'game')
        window.v3.events.push({ ...entry, observed: game.session.getState() });
    });
    for (const actor of game.session.getState().actors)
      game.session.useScript(actor.id, () => ({}), 'idle test actor');
  });
  await page.waitForFunction(
    () => window.v3.game.session.getState().boundary.phase === 'shrinking',
    undefined,
    { timeout: 15000 },
  );
  const shrinking = await page.evaluate(() => window.v3.game.session.snapshot());
  assert.equal(shrinking.state.suddenDeathStarted, true);
  assert(shrinking.state.boundary.halfSize.x > shrinking.state.boundary.halfSize.y);
  assert(shrinking.state.boundary.duration > 0);
  await shot('B01-real-rectangle-shrinking', 'public-session');
  pass(
    'real public session starts rectangular sudden death with idle controllers',
    'public-session',
    {
      tick: shrinking.tick,
      roundTime: shrinking.state.roundTime,
      boundary: shrinking.state.boundary,
    },
  );

  await page.waitForFunction(
    () =>
      window.v3.game.session
        .getState()
        .actors.some(
          (actor) =>
            actor.alive &&
            actor.outOfBounds &&
            actor.outOfBounds.remaining < actor.outOfBounds.duration * 0.7,
        ),
    undefined,
    { timeout: 25000 },
  );
  await page.evaluate(() => window.v3.game.pause());
  await frame();
  await page.waitForTimeout(80);
  const paused = await page.evaluate(() => window.v3.game.session.snapshot());
  assert.equal(paused.status, 'paused');
  const threatened = paused.state.actors.filter((actor) => actor.outOfBounds);
  assert(
    threatened.length > 0 &&
      threatened.every((actor) => actor.alive && actor.outOfBounds.remaining > 0),
  );
  const frozenHash = await shot('B04-real-warning-paused', 'public-session');
  await page.waitForTimeout(350);
  assert.deepEqual(await page.evaluate(() => window.v3.game.session.snapshot()), paused);
  await shot('B04-real-warning-still-frozen', 'public-session');
  const frozenPixels = await comparePixels(
    'B04-real-warning-paused',
    'B04-real-warning-still-frozen',
  );
  pass('pause freezes real out-of-bounds timers and rendered warning canvas', 'public-session', {
    tick: paused.tick,
    actors: threatened.map(({ id, outOfBounds }) => ({ id, outOfBounds })),
    canvasSha256: frozenHash,
    pixelComparison: frozenPixels,
  });
  const recoveringId = threatened[0].id;
  await page.evaluate((actorId) => {
    window.v3.game.session.useScript(
      actorId,
      ({ state }) => {
        const actor = state.actors.find((candidate) => candidate.id === actorId);
        const bounds = state.boundary;
        const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
        const target = {
          x: clamp(
            actor.position.x,
            bounds.center.x - bounds.halfSize.x + 0.9,
            bounds.center.x + bounds.halfSize.x - 0.9,
          ),
          y: clamp(
            actor.position.y,
            bounds.center.y - bounds.halfSize.y + 0.9,
            bounds.center.y + bounds.halfSize.y - 0.9,
          ),
        };
        const x = target.x - actor.position.x,
          y = target.y - actor.position.y;
        const length = Math.hypot(x, y);
        return length > 0.05 ? { move: { x: x / length, y: y / length } } : {};
      },
      'return to safe rectangle',
    );
    window.v3.game.resume();
  }, recoveringId);
  await page.waitForFunction(
    (actorId) => {
      const state = window.v3.game.session.getState();
      const actor = state.actors.find((candidate) => candidate.id === actorId);
      return (
        actor.alive &&
        !actor.outOfBounds &&
        Math.min(
          state.boundary.halfSize.x - Math.abs(actor.position.x - state.boundary.center.x),
          state.boundary.halfSize.y - Math.abs(actor.position.y - state.boundary.center.y),
        ) > 0.25
      );
    },
    recoveringId,
    { timeout: 5000 },
  );
  await page.evaluate(() => window.v3.game.pause());
  await frame();
  const recovered = await page.evaluate((actorId) => {
    const snapshot = window.v3.game.session.snapshot();
    return {
      tick: snapshot.tick,
      actor: snapshot.state.actors.find((actor) => actor.id === actorId),
      boundary: snapshot.state.boundary,
    };
  }, recoveringId);
  assert.equal(recovered.actor.alive, true);
  assert.equal(recovered.actor.outOfBounds, undefined);
  assert(
    Math.hypot(
      recovered.actor.position.x - threatened[0].position.x,
      recovered.actor.position.y - threatened[0].position.y,
    ) > 0.3,
  );
  await shot('B02-real-returned-alive', 'public-session');
  pass(
    'public script moves an endangered actor back inside and clears its countdown alive',
    'public-session',
    {
      beforeTick: paused.tick,
      beforePosition: threatened[0].position,
      after: recovered,
    },
  );
  await page.evaluate(
    (actorId) => window.v3.game.session.useScript(actorId, () => ({}), 'idle after return'),
    recoveringId,
  );
  await page.evaluate(() => window.v3.game.resume());
  await page.waitForFunction(
    () => window.v3.events.some((entry) => entry.event.type === 'death'),
    undefined,
    { timeout: 12000 },
  );
  await page.evaluate(() => window.v3.game.pause());
  await frame();
  const deaths = await page.evaluate(() =>
    window.v3.events
      .filter((entry) => entry.event.type === 'death')
      .map((entry) => ({
        tick: entry.tick,
        event: entry.event,
        actor: entry.observed.actors.find((actor) => actor.id === entry.event.actorId),
      })),
  );
  assert(deaths.length > 0);
  for (const death of deaths) {
    assert.equal(death.event.cause, 'boundary');
    assert.equal(death.event.variant, 'burst');
    assert.equal(death.actor.alive, false);
    assert.equal(death.actor.death.variant, death.event.variant);
    assert.equal(death.actor.death.cause, death.event.cause);
  }
  assert.equal(new Set(deaths.map((death) => death.event.actorId)).size, deaths.length);
  await shot('B03-real-boundary-death', 'public-session');
  pass('real boundary expiration emits one matching persistent death per actor', 'public-session', {
    deaths,
  });

  await page.evaluate(() => {
    window.v3.game.start({ mapId: 'canal', suddenDeathTime: 1000 });
    window.v3.game.pause();
  });
  await frame();
  const restarted = await page.evaluate(() => ({
    state: window.v3.game.session.snapshot(),
    stats: window.v3.game.stats(),
  }));
  assert.equal(restarted.state.tick, 0);
  assert.equal(restarted.state.state.round, 1);
  assert.equal(restarted.state.state.boundary.phase, 'idle');
  assert.equal(restarted.state.state.suddenDeathStarted, false);
  assert(
    restarted.state.state.actors.every(
      (actor) => actor.alive && !actor.death && !actor.fall && !actor.outOfBounds,
    ),
  );
  assert.equal(restarted.stats.frameErrors, 0);
  assert.equal(restarted.state.listenerErrors, 0);
  await shot('L01-real-restart-clears-danger', 'public-session');
  const disposed = await page.evaluate(() => {
    const game = window.v3.game;
    game.destroy();
    game.destroy();
    return {
      frames: game.stats().frames,
      status: game.session.snapshot().status,
      canvases: document.querySelectorAll('#v3-arena canvas').length,
      hud: document.querySelectorAll('#v3-arena .garden-sdk-hud').length,
    };
  });
  await page.keyboard.press('d');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.v3.game.stats().frames), disposed.frames);
  assert.deepEqual(
    { ...disposed, frames: 0 },
    { frames: 0, status: 'disposed', canvases: 0, hud: 0 },
  );
  pass('public restart resets feedback and destroy removes canvas HUD and RAF', 'public-session', {
    disposed,
  });

  await shell('V3: isolated presentation fixtures (synthetic state, no combat claims)');
  await page.evaluate(async () => {
    const [
      { GameRenderer },
      { createState, defaultOptions },
      { createCharacter, updateCharacter },
      { Effects },
      { BoundaryView },
    ] = await Promise.all([
      import('/src/rendering/renderer.ts'),
      import('/src/simulation/state.ts'),
      import('/src/rendering/characters.ts'),
      import('/src/rendering/effects.ts'),
      import('/src/rendering/boundary-view.ts'),
    ]);
    const state = createState({ ...defaultOptions(), mode: 'local', bots: 0, mapId: 'courtyard' });
    state.phase = 'playing';
    state.phaseTime = 6;
    state.time = 10;
    state.roundTime = 8;
    state.weaponsGranted = true;
    for (const actor of state.actors) {
      actor.armed = true;
      actor.velocity = { x: 0, y: 0 };
    }
    state.actors[0].position = { x: -3, y: 3.8 };
    state.actors[0].previous = { ...state.actors[0].position };
    const renderer = new GameRenderer(document.querySelector('#v3-arena'), state);
    window.v3 = {
      renderer,
      base: structuredClone(state),
      state,
      createCharacter,
      updateCharacter,
      Effects,
      BoundaryView,
    };
    window.v3.draw = (next) => {
      window.v3.state = next;
      renderer.draw(next, 1, next.time, 0, false);
    };
    window.v3.draw(state);
  });
  await frame();
  const boundaryEvidence = await page.evaluate(() => {
    const state = structuredClone(window.v3.base);
    state.boundary = {
      ...state.boundary,
      phase: 'shrinking',
      center: { x: 2, y: -1 },
      halfSize: { x: 8, y: 4 },
      targetCenter: { x: 4, y: -2 },
      progress: 0.4,
      elapsed: 4,
      duration: 10,
      startedAt: 6,
    };
    state.actors[0].outOfBounds = { duration: 3.75, remaining: 1.2 };
    const visual = new window.v3.BoundaryView();
    visual.update(state, false);
    const [line, glow, marker] = visual.root.children;
    visual.root.updateMatrixWorld(true);
    const pointer = visual.root.children[3].children[1];
    const tip = pointer.localToWorld(pointer.position.clone().set(0, 0.65, 0));
    const tail = pointer.localToWorld(pointer.position.clone().set(0, -0.35, 0));
    const heading = tip.sub(tail).normalize();
    const desired = pointer.position
      .clone()
      .set(
        state.boundary.center.x - state.actors[0].position.x,
        0,
        state.boundary.center.y - state.actors[0].position.y,
      )
      .normalize();
    const evidence = {
      name: visual.root.name,
      center: line.position.toArray(),
      halfSize: line.material.uniforms.halfSize.value.toArray(),
      glowWalls: glow.children.length,
      markerArrows: marker.children.length,
      warningGroups: visual.root.children.length - 3,
      opacity: line.material.uniforms.opacity.value,
      scroll: line.material.uniforms.scroll.value,
      warningArrowHeading: heading.toArray(),
      returnDirection: desired.toArray(),
      arrowDirectionDot: heading.dot(desired),
    };
    visual.reset();
    evidence.afterResetChildren = visual.root.children.length;
    visual.dispose();
    window.v3.draw(state);
    return evidence;
  });
  assert.equal(boundaryEvidence.name, 'game-boundary');
  assert.deepEqual(boundaryEvidence.halfSize, [8, 4]);
  assert.deepEqual(boundaryEvidence.center, [2, 0.07, -1]);
  assert.equal(boundaryEvidence.glowWalls, 4);
  assert.equal(boundaryEvidence.markerArrows, 4);
  assert.equal(boundaryEvidence.warningGroups, 1);
  assert.equal(boundaryEvidence.afterResetChildren, 3);
  assert.equal(boundaryEvidence.opacity, 0.8);
  assert.equal(boundaryEvidence.scroll, 0.25);
  assert(
    boundaryEvidence.arrowDirectionDot > 0.999,
    'The visible arrow tip must point toward the safe rectangle.',
  );
  await shot('B05-fixture-rectangle-and-warning', 'presentation-fixture');
  pass(
    'boundary fixture binds rectangular axes, four glow walls, arrows and resettable warning',
    'presentation-fixture',
    boundaryEvidence,
  );

  const variantHashes = {},
    variantEvidence = [];
  for (const variant of ['slice', 'squash', 'water', 'cliff', 'burst']) {
    const evidence = await page.evaluate((kind) => {
      const state = structuredClone(window.v3.base),
        actor = state.actors[0];
      const cause =
        kind === 'slice'
          ? 'weapon'
          : kind === 'squash'
            ? 'explosion'
            : kind === 'burst'
              ? 'boundary'
              : 'fall';
      const position =
        kind === 'water'
          ? { x: -9.8, y: -0.2 }
          : kind === 'cliff'
            ? { x: 13.2, y: 1 }
            : { x: -3, y: 3.8 };
      state.time = 10.35;
      actor.position = position;
      actor.previous = { ...position };
      actor.alive = false;
      actor.invulnerable = 2;
      actor.deathTime = 10;
      actor.death = {
        cause,
        variant: kind,
        time: 10,
        position,
        direction: { x: 1, y: -0.3 },
        seed: 777,
      };
      actor.armed = false;
      window.v3.renderer.reset(state);
      window.v3.draw(state);
      const view = window.v3.createCharacter(actor);
      window.v3.updateCharacter(view, actor, 1, state.time);
      const effects = new window.v3.Effects();
      effects.syncDeaths(state);
      const [particles, rings, splats] = effects.root.children[0].children;
      const result = {
        variant: kind,
        bodyVisible: view.body.visible,
        deathVisible: view.death.root.visible,
        stump: view.death.stump.visible,
        piece: view.death.piece.visible,
        squash: view.death.squash.visible,
        particles: particles.children.filter((item) => item.visible).length,
        rings: rings.children.filter((item) => item.visible).length,
        splats: splats.children.filter((item) => item.visible).length,
      };
      effects.clear();
      view.root.traverse((object) => {
        object.geometry?.dispose();
        if (object.isSprite) {
          object.material.map?.dispose();
          object.material.dispose();
        } else if (object.material && !object.material.userData?.shared) object.material.dispose();
      });
      return result;
    }, variant);
    assert.equal(evidence.bodyVisible, false, 'Dead invulnerable actors must not blink alive.');
    assert.equal(evidence.deathVisible, true);
    assert.equal(evidence.stump, variant === 'slice');
    assert.equal(evidence.piece, variant === 'slice');
    assert.equal(evidence.squash, variant === 'squash');
    assert(evidence.particles > 0);
    if (variant === 'water') assert(evidence.rings >= 2);
    variantEvidence.push(evidence);
    variantHashes[variant] = await shot(`D-fixture-${variant}`, 'presentation-fixture');
  }
  assert.equal(new Set(Object.values(variantHashes)).size, 5);
  pass(
    'five death variants render distinct models and particles without dead-body invulnerability flicker',
    'presentation-fixture',
    { variants: variantEvidence, canvasHashes: variantHashes },
  );

  const first = await shot('D-fixture-seek-baseline', 'presentation-fixture');
  await page.evaluate(() => {
    const state = structuredClone(window.v3.state);
    state.time = 12;
    window.v3.draw(state);
  });
  await page.evaluate(() => {
    const state = structuredClone(window.v3.state);
    state.time = 10.35;
    window.v3.draw(state);
  });
  await shot('D-fixture-seek-restored', 'presentation-fixture');
  const seekPixels = await comparePixels('D-fixture-seek-baseline', 'D-fixture-seek-restored');
  pass(
    'death fixture returns to the same rendered pixels after a backward seek',
    'presentation-fixture',
    { sha256: first, pixelComparison: seekPixels },
  );

  const memory = await page.evaluate(() => {
    const rows = [];
    for (let index = 0; index < 12; index++) {
      const state = structuredClone(window.v3.base);
      state.round = index + 2;
      state.time = 20 + index;
      window.v3.renderer.reset(state);
      window.v3.draw(state);
      rows.push(window.v3.renderer.stats());
    }
    return rows;
  });
  const settled = memory.slice(2);
  assert.equal(new Set(settled.map((entry) => entry.geometries)).size, 1);
  assert.equal(new Set(settled.map((entry) => entry.textures)).size, 1);
  await shot('L02-fixture-reset-stable', 'presentation-fixture');
  await page.evaluate(() => window.v3.renderer.dispose());
  assert.equal(await page.locator('#v3-arena canvas').count(), 0);
  pass(
    'repeated renderer reset clears death and warning resources to a stable baseline',
    'presentation-fixture',
    { samples: memory },
  );
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error.stack ?? String(error);
  await page.screenshot({ path: resolve(OUT, 'failure.png') }).catch(() => {});
  console.error(failure);
} finally {
  const finalSources = await sources();
  const changedSources = [
    ...new Set([...Object.keys(initialSources), ...Object.keys(finalSources)]),
  ].filter((path) => initialSources[path] !== finalSources[path]);
  if (changedSources.length && !failure)
    failure = `Sources changed during verification: ${changedSources.join(', ')}`;
  if (errors.length && !failure) failure = `Browser errors: ${errors.join('; ')}`;
  await writeFile(
    resolve(OUT, 'report.json'),
    `${JSON.stringify(
      {
        ok: failure === null,
        beganAt,
        finishedAt: new Date().toISOString(),
        url: BASE,
        evidenceBoundaries: {
          publicSession:
            'Natural BrowserGame RAF with public options/controllers/pause/restart; no state mutation or manual step.',
          presentationFixture:
            'Synthetic state sent to isolated source renderer/components; verifies pixels/resources, not combat correctness.',
          originalGame: 'No original game execution or runtime comparison.',
        },
        notCovered: [
          'No original-game runtime or pixel comparison.',
          'Source-dev renderer only; final installed SDK package is verified separately.',
          'Natural combat for weapon/explosion/water/cliff is not covered here; those variants use isolated presentation fixtures.',
          'Actual fall-rescue controls, simultaneous final kills and full match-point/timeout UI need their own scenarios.',
          'Resource sampling is 12 same-map renderer resets, not a long multi-map browser soak.',
          'No mobile viewport, real gamepad, audio waveform or subjective sound comparison.',
        ],
        checks,
        screenshots,
        errors,
        serverMessages,
        changedSources,
        sourceHashes: initialSources,
        failure,
      },
      null,
      2,
    )}\n`,
  );
  await browser.close();
}
if (failure) process.exitCode = 1;
