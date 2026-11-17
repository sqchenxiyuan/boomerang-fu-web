import assert from 'node:assert/strict';
import { createSession } from '@boomerang-garden/sdk';

// This example uses only the public SDK. It needs no browser, canvas or game installation.
// Kill scoring (the default) with a short five-point goal keeps the example quick.
const session = createSession({
  mapId: 'portals',
  mapRotation: 'cycle',
  seed: 295,
  bots: 1,
  scoreGoal: 5,
});
session.useBot(0);
session.useBot(1);
const events = {};
const unsubscribe = session.onEvent((entry) => {
  if (entry.type === 'game') events[entry.event.type] = (events[entry.event.type] ?? 0) + 1;
});
let ticks = 0;
while (session.getState().phase !== 'matchEnd' && ticks < 60 * 700) {
  session.step();
  ticks++;
}
const state = session.getState();
assert.equal(state.phase, 'matchEnd', 'Bots must finish by playing a complete match.');
const winner = state.actors.find((actor) => actor.id === state.matchWinnerId);
assert.ok(winner && winner.score >= state.options.scoreGoal);
assert.ok(events.throw > 0 && events.death >= 5);
const result = {
  ok: true,
  ticks,
  seconds: ticks / 60,
  rounds: state.round,
  scores: state.actors.map((actor) => actor.score),
  kills: state.actors.map((actor) => actor.kills),
  events,
};
unsubscribe();
session.destroy();
console.log(JSON.stringify(result));
