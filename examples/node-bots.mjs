import assert from 'node:assert/strict';
import { createSession } from '@boomerang-garden/sdk';

// This example uses only the public SDK. It needs no browser, canvas or game installation.
const session = createSession({ mapId: 'portals', mapRotation: 'cycle', seed: 295, bots: 1 });
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
assert.ok(state.actors.some((actor) => actor.score === 5));
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
