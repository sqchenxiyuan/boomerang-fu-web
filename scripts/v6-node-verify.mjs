import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { createSession, runAIMatch, createHttpAgent, ReplayPlayer } from '../dist-sdk/lib/index.js';
import { createAgentServer } from '../examples/http-agent.mjs';

await mkdir('test-results/v6', { recursive: true });
const report = { ok: false, matches: [], sizes: [], http: {} };
await writeFile('test-results/v6/node.json', JSON.stringify(report));
for (const seed of [8751, 8752, 8753]) {
  const result = await runAIMatch({
    match: { mode: 'bots', bots: 4, mapId: 'courtyard', seed, scoreGoal: 2, suddenDeathTime: 15 },
    record: true,
  });
  assert(result.completed);
  assert.equal(result.agentErrors.length, 0);
  const data = result.recording,
    replay = new ReplayPlayer(data);
  replay.step(data.durationTicks);
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay.getState())),
    JSON.parse(JSON.stringify(result.state)),
  );
  const seekStart = performance.now();
  replay.seek(Math.floor(data.durationTicks * 0.7));
  const seekMs = performance.now() - seekStart;
  report.matches.push({
    seed,
    ticks: result.ticks,
    simulationSeconds: result.simulationSeconds,
    wallSeconds: result.wallSeconds,
    rate: result.simulationRate,
    seekMs,
  });
  if (seed === 8751) {
    let everyTickBytes = 0;
    replay.seek(0);
    for (let tick = 0; tick < data.durationTicks; tick++) {
      replay.step();
      everyTickBytes += Buffer.byteLength(JSON.stringify(replay.getState()));
    }
    const actionOnly = { ...data, checkpoints: data.checkpoints.slice(0, 1) };
    report.sizes.push({
      map: 'courtyard',
      ticks: data.durationTicks,
      hybridBytes: Buffer.byteLength(JSON.stringify(data)),
      gzipBytes: gzipSync(JSON.stringify(data)).length,
      actionOnlyBytes: Buffer.byteLength(JSON.stringify(actionOnly)),
      fullStateEveryTickBytes: everyTickBytes,
    });
    await writeFile('test-results/v6/node-replay.bgr.gz', gzipSync(JSON.stringify(data)));
  }
}
const dense = createSession({ mode: 'local', bots: 0, mapId: 'original-plants', seed: 71 });
dense.startRecording({ checkpointInterval: 60 });
dense.step(600);
const denseData = dense.stopRecording();
const denseReplay = new ReplayPlayer(denseData);
denseReplay.seek(denseData.durationTicks);
report.sizes.push({
  map: 'original-plants',
  ticks: 600,
  hybridBytes: Buffer.byteLength(JSON.stringify(denseData)),
  gzipBytes: gzipSync(JSON.stringify(denseData)).length,
  checkpoints: denseData.checkpoints.length,
});
dense.startRecording({ checkpointInterval: 60 });
while (dense.recording && dense.tick < 6600) dense.step(600);
assert.equal(dense.recording, null);
const capped = dense.getRecording();
assert.equal(capped.stopReason, 'size-limit');
const cappedBytes = Buffer.byteLength(JSON.stringify(capped));
assert(cappedBytes < 64 * 1024 * 1024);
const cappedReplay = new ReplayPlayer(capped);
cappedReplay.seek(capped.durationTicks);
report.capacity = {
  ticks: capped.durationTicks,
  bytes: cappedBytes,
  reason: capped.stopReason,
  importable: true,
};
dense.destroy();

let requests = 0;
const server = createAgentServer((obs) => {
  requests++;
  return {
    move: { x: obs.actorId ? -1 : 1, y: 0 },
    throw: obs.tick % 90 < 48,
    attack: obs.tick % 30 < 6,
  };
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = `http://127.0.0.1:${server.address().port}/action`;
  const result = await runAIMatch({
    match: { mapId: 'courtyard', seed: 71 },
    agents: { 0: createHttpAgent(endpoint), 1: createHttpAgent(endpoint) },
    record: true,
    maxTicks: 600,
  });
  assert(requests > 0);
  assert.deepEqual(result.agentErrors, []);
  const replay = new ReplayPlayer(result.recording);
  replay.step(600);
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay.getState())),
    JSON.parse(JSON.stringify(result.state)),
  );
  report.http.validRequests = requests;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

let responseMode = 'stale';
const invalid = createServer(async (req, res) => {
  let input = '';
  for await (const part of req) input += part;
  const obs = JSON.parse(input);
  if (responseMode === 'hang') return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    responseMode === 'large'
      ? ' '.repeat(70000)
      : JSON.stringify({ ...obs, tick: obs.tick + 1, action: {} }),
  );
});
await new Promise((resolve) => invalid.listen(0, '127.0.0.1', resolve));
try {
  const policy = createHttpAgent(`http://127.0.0.1:${invalid.address().port}`);
  const observation = {
    protocol: 'boomerang-garden.agent.v1',
    actorId: 0,
    tick: 1,
    dt: 1 / 60,
    actionTicks: 6,
    state: {},
  };
  await assert.rejects(policy(observation, new AbortController().signal), /does not match/);
  responseMode = 'large';
  await assert.rejects(policy(observation, new AbortController().signal), /too large/);
  responseMode = 'hang';
  const timed = await runAIMatch({ maxTicks: 240, timeoutMs: 10, agents: { 0: policy } });
  assert(timed.agentErrors.length > 0);
  assert.equal(timed.ticks, 240);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const aborted = await runAIMatch({
    signal: controller.signal,
    agents: { 0: policy },
    timeoutMs: 2000,
  });
  assert.equal(aborted.reason, 'aborted');
  report.http.staleRejected = true;
  report.http.oversizeRejected = true;
  report.http.timeouts = timed.agentErrors.length;
  report.http.cancelled = true;
} finally {
  invalid.closeAllConnections();
  await new Promise((resolve) => invalid.close(resolve));
}
report.ok = true;
await writeFile('test-results/v6/node.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
