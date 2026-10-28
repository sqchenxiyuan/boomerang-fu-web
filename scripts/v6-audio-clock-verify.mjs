// Development-only instrumentation: isolate the audio graph and RAF clock from rendering.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
await mkdir('test-results/v6/audio', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { ok: false, audio: [], errors: [], clock: [] };
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await page.evaluate(() => window.boomerangGarden.destroy());
  await page.evaluate(async () => {
    const source = await (await fetch('/src/platform/audio-score.ts')).text();
    const path = source.match(/from "([^"]*\/tone\.js[^"]*)"/)[1];
    window.audioProbe = {
      Tone: await import(path),
      ...(await import('/src/platform/audio-score.ts')),
    };
  });
  for (const scene of ['menu', 'play', 'danger', 'victory']) {
    const result = await page.evaluate(async (scene) => {
      const { Tone, GardenAudioGraph } = window.audioProbe;
      let graph;
      const types = [
        'slash',
        'throw',
        'bounce',
        'catch',
        'deflect',
        'shield',
        'crate',
        'death',
        'explosion',
        'pickup',
        'teleport',
        'equip',
      ];
      const buffer = await Tone.Offline(
        (context) => {
          graph = new GardenAudioGraph(context);
          graph.configure({ music: 0.7, sfx: 0.75, muted: false });
          graph.setScene(scene, true);
          if (scene === 'play')
            types.forEach((type, index) =>
              context.transport.scheduleOnce(
                (time) =>
                  graph.play(
                    [{ type, position: { x: 0, y: 0 }, actorId: 0, variant: 'water' }],
                    time,
                  ),
                0.2 + index * 0.32,
              ),
            );
        },
        5,
        1,
        22050,
      );
      const samples = Array.from(buffer.getChannelData(0));
      let power = 0,
        peak = 0;
      for (const v of samples) {
        power += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      const stats = {
        scene,
        rms: Math.sqrt(power / samples.length),
        peak,
        musicNotes: graph.musicNotes,
        effects: graph.effectEvents,
        samples,
      };
      graph.dispose();
      buffer.dispose();
      return stats;
    }, scene);
    assert(result.rms > 0.0001);
    assert(result.peak < 0.99);
    assert(result.musicNotes > 0);
    const samples = result.samples;
    delete result.samples;
    report.audio.push(result);
    const wav = Buffer.alloc(44 + samples.length * 2);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(22050, 24);
    wav.writeUInt32LE(44100, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(samples.length * 2, 40);
    samples.forEach((sample, index) =>
      wav.writeInt16LE(
        Math.max(-32768, Math.min(32767, Math.round(sample * 32767))),
        44 + index * 2,
      ),
    );
    await writeFile(`test-results/v6/audio/${scene}.wav`, wav);
  }
  const stress = await page.evaluate(async () => {
    const { Tone, GardenAudioGraph } = window.audioProbe;
    const context = new Tone.Context(),
      graph = new GardenAudioGraph(context);
    await context.resume();
    graph.setScene('danger', true);
    const types = [
      'throw',
      'dash',
      'slash',
      'deflect',
      'bounce',
      'catch',
      'equip',
      'shield',
      'crate',
      'death',
      'explosion',
      'pickup',
      'teleport',
      'countdown',
      'boundary',
      'freeze',
      'burn',
      'split',
      'win',
    ];
    for (let index = 0; index < 200; index++) {
      graph.play(types.map((type) => ({ type, position: { x: 0, y: 0 }, actorId: 0 })));
      await new Promise((done) => setTimeout(done, 4));
    }
    const effects = graph.effectEvents;
    graph.dispose();
    await context.close();
    context.dispose();
    return effects;
  });
  assert(stress > 100);
  report.stressEffects = stress;
  // Two independently supplied contexts must keep transports and volumes separate.
  report.isolation = await page.evaluate(async () => {
    const { Tone, GardenAudioGraph } = window.audioProbe;
    const a = new Tone.Context(),
      b = new Tone.Context(),
      ga = new GardenAudioGraph(a),
      gb = new GardenAudioGraph(b);
    await Promise.all([a.resume(), b.resume()]);
    ga.setScene('play', true);
    gb.setScene('menu', true);
    await new Promise((done) => setTimeout(done, 150));
    ga.setScene('play', false);
    ga.configure({ music: 0, sfx: 0, muted: true });
    await new Promise((done) => setTimeout(done, 150));
    const value = {
      a: a.transport.state,
      b: b.transport.state,
      gainA: ga.master.gain.value,
      gainB: gb.master.gain.value,
    };
    ga.dispose();
    gb.dispose();
    await Promise.all([a.close(), b.close()]);
    a.dispose();
    b.dispose();
    return value;
  });
  assert.equal(report.isolation.a, 'paused');
  assert.equal(report.isolation.b, 'started');
  assert.equal(report.isolation.gainA, 0);
  assert(report.isolation.gainB > 0);
  report.clock = await page.evaluate(async () => {
    const { FixedLoop } = await import('/src/platform/loop.ts');
    const { createSession } = await import('/src/sdk/index.ts');
    const results = [];
    for (const scale of [0.25, 1, 4, 8]) {
      const session = createSession({ mode: 'bots', bots: 2, mapId: 'courtyard', seed: 55 });
      const loop = new FixedLoop();
      loop.timeScale = scale;
      const start = performance.now();
      await new Promise((resolve) => {
        loop.onStep = () => {
          if (session.tick === 120) {
            loop.stop();
            resolve();
            return false;
          }
          session.step();
          return true;
        };
        loop.start();
      });
      results.push({
        scale,
        ticks: session.tick,
        seconds: (performance.now() - start) / 1000,
        state: session.getState(),
        stats: loop.stats(),
      });
      session.destroy();
    }
    return results;
  });
  const reference = report.clock[0].state;
  for (const item of report.clock) {
    assert.deepEqual(item.state, reference);
    assert.equal(item.stats.steps, 120);
    delete item.state;
  }
  assert.deepEqual(report.errors, []);
  report.ok = true;
} finally {
  await browser.close();
  await writeFile('test-results/v6/audio/report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
