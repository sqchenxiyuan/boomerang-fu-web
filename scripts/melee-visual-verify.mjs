import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const out = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/melee/current';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 520 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
});
try {
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(() => window.boomerangGarden);
  const report = await page.evaluate(async (mode) => {
    window.boomerangGarden.destroy();
    const { createSession } = await import('/src/sdk/session.ts');
    const { GameRenderer } = await import('/src/rendering/renderer.ts');
    document.body.innerHTML =
      '<div id="stage" style="position:relative;width:640px;height:520px"></div>';
    const session = createSession({
      mode: 'local',
      bots: 0,
      seed: 41,
      mapId: 'courtyard',
      startingPowers: mode === 'unarmed' ? ['explosive'] : mode === 'dual' ? ['extra'] : [],
    });
    session.start();
    for (const a of session.getState().actors) session.useScript(a.id, () => ({}));
    for (let i = 0; i < 260; i++) session.step();
    const input = session.acquire(0, 'melee visual verification');
    input.submit({ move: { x: 1, y: 0 } }, 8);
    for (let i = 0; i < 60; i++) session.step();
    if (!session.getState().actors[0].armed)
      throw new Error('Weapon not granted through normal play');
    if (mode === 'unarmed') {
      input.submit({ throw: true }, 10);
      session.step();
      input.submit({ throw: false }, 1);
      session.step();
      for (let i = 0; i < 40; i++) session.step();
      if (session.getState().actors[0].armed) throw new Error('Throw did not leave actor unarmed');
    }
    const ready = session.getState();
    const frames = [{ ms: -1, state: ready }];
    input.submit({ attack: true }, 1);
    session.step();
    const start = session.getState().time;
    frames.push({ ms: 0, state: session.getState() });
    for (let i = 1; i <= 30; i++) {
      session.step();
      if ([2, 4, 7, 11, 16, 24, 30].includes(i))
        frames.push({
          ms: Math.round((session.getState().time - start) * 1000),
          state: session.getState(),
        });
    }
    const renderer = new GameRenderer(document.getElementById('stage'), ready);
    const origin = ready.actors[0].position;
    window.meleeFixture = {
      renderer,
      frames,
      session,
      draw(index) {
        const state = frames[index].state;
        renderer.draw(state, 1, state.time, 0, false);
        renderer.camera.position.set(origin.x + 8, 7, origin.y + 4);
        renderer.camera.lookAt(origin.x + 1, 0.65, origin.y);
        renderer.renderer.render(renderer.scene, renderer.camera);
        return renderer.canvas.toDataURL();
      },
    };
    return {
      kind: 'public Session action and natural fixed steps; presentation camera only',
      mode,
      frames: frames.map((f) => ({
        ms: f.ms,
        attackTime: f.state.actors[0].attackTime,
        lungeRecovery: f.state.actors[0].lungeRecovery,
        serial: f.state.actors[0].attackSerial,
      })),
      after: session.getState(),
    };
  }, process.env.GARDEN_MELEE_MODE ?? 'armed');
  const images = [];
  for (let i = 0; i < report.frames.length; i++) {
    const data = await page.evaluate((i) => window.meleeFixture.draw(i), i);
    images.push(data);
    await writeFile(`${out}/frame-${i}.png`, Buffer.from(data.split(',')[1], 'base64'));
  }
  const sheet = await page.evaluate(
    async ({ images, frames }) => {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 870;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f7f3e7';
      ctx.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < images.length; i++) {
        const img = new Image();
        img.src = images[i];
        await img.decode();
        const x = (i % 3) * 426,
          y = Math.floor(i / 3) * 290;
        ctx.drawImage(img, x, y, 426, 260);
        ctx.fillStyle = '#173e35';
        ctx.font = '16px sans-serif';
        ctx.fillText(frames[i].ms < 0 ? 'READY' : `${frames[i].ms} ms`, x + 16, y + 282);
      }
      return c.toDataURL();
    },
    { images, frames: report.frames },
  );
  await writeFile(`${out}/sequence.png`, Buffer.from(sheet.split(',')[1], 'base64'));
  const first = await page.evaluate(() => window.meleeFixture.draw(4));
  const repeated = await page.evaluate(() => window.meleeFixture.draw(4));
  async function compare(first, second) {
    const result = await page.evaluate(
      async ([a, b]) => {
        const decode = async (data) => {
          const image = new Image();
          image.src = data;
          await image.decode();
          const canvas = new OffscreenCanvas(image.width, image.height),
            ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, image.width, image.height).data;
        };
        const [x, y] = await Promise.all([decode(a), decode(b)]);
        let pixels = 0,
          maxDelta = 0;
        for (let i = 0; i < x.length; i += 4) {
          let changed = false;
          for (let c = 0; c < 4; c++) {
            const d = Math.abs(x[i + c] - y[i + c]);
            maxDelta = Math.max(maxDelta, d);
            changed ||= d > 0;
          }
          if (changed) pixels++;
        }
        return { changedPixels: pixels, total: x.length / 4, maxDelta };
      },
      [first, second],
    );
    assert(
      result.maxDelta <= 1 && result.changedPixels / result.total <= 0.00005,
      JSON.stringify(result),
    );
    return result;
  }
  const pausedPixels = await compare(first, repeated);
  await page.evaluate(() => window.meleeFixture.draw(8));
  const seekPixels = await compare(first, await page.evaluate(() => window.meleeFixture.draw(4)));
  const actual = await page.evaluate(() => window.meleeFixture.session.getState());
  assert.deepEqual(actual, report.after, 'Drawing never mutates simulation');
  assert.deepEqual(errors, []);
  await page.evaluate(() => {
    window.meleeFixture.renderer.dispose();
    window.meleeFixture.session.destroy();
  });
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        ...report,
        after: undefined,
        errors,
        pausedPixels,
        seekPixels,
        stateUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      frames: report.frames.length,
      errors,
      pausedPixels: true,
      seekPixels: true,
      stateUnchanged: true,
    }),
  );
} finally {
  await browser.close();
}
