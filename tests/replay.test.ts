import { describe, expect, it } from 'vitest';
import { createSession } from '../src/sdk/session';
import { checkpointHash, parseReplay, ReplayPlayer } from '../src/sdk/recording';
import type { MapId } from '../src/core/types';

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('action recording with simulation checkpoints', () => {
  it.each([
    'original-falling2',
    'original-turn-teleportals',
    'original-plants',
    'original-trap',
    'original-four-cogs',
  ] as MapId[])(
    'roundtrips dynamic map %s, powerups and checkpoint seeks',
    (mapId) => {
      const game = createSession({
        mode: 'bots',
        bots: 4,
        mapId,
        seed: 71,
        scoreGoal: 2,
        suddenDeathTime: 10,
        startingPowers: ['fire', 'multi', 'shield'],
      });
      game.startRecording({ checkpointInterval: 300 });
      game.step(900);
      const data = game.stopRecording()!;
      const player = new ReplayPlayer(data);
      player.step(Math.max(1, data.durationTicks));
      expect(json(player.getState())).toEqual(json(game.getState()));
      player.seek(Math.min(610, data.durationTicks));
      player.step(Math.max(1, data.durationTicks));
      expect(json(player.getState())).toEqual(json(game.getState()));
      game.destroy();
    },
    30000,
  );

  it('replays multiple rounds with map rotation and an empty recording', () => {
    const game = createSession({
      mode: 'bots',
      bots: 4,
      mapId: 'courtyard',
      mapRotation: 'cycle',
      seed: 8751,
      scoreGoal: 2,
      suddenDeathTime: 5,
    });
    game.startRecording();
    const empty = game.stopRecording()!;
    expect(new ReplayPlayer(empty).status).toBe('ended');
    game.startRecording();
    game.step(6000);
    const data = game.stopRecording()!;
    expect(game.getState().round).toBeGreaterThan(1);
    const replay = new ReplayPlayer(data);
    replay.step(data.durationTicks);
    expect(json(replay.getState())).toEqual(json(game.getState()));
    game.destroy();
  }, 30000);

  it('rejects malformed required and optional state even with recalculated checksums', () => {
    const game = createSession();
    game.startRecording();
    game.step(10);
    const original = game.stopRecording()!;
    for (const corrupt of [
      (state: any) => delete state.boundary,
      (state: any) => {
        state.actors[0].death = { variant: 'oops' };
      },
      (state: any) => {
        state.actors[0].powers = ['missing'];
      },
      (state: any) => {
        state.arena.obstacles[0].paths = [['invalid']];
      },
    ]) {
      const data = structuredClone(original);
      corrupt(data.checkpoints[0].world.state);
      data.checkpoints[0].hash = checkpointHash(data.checkpoints[0].world);
      expect(() => new ReplayPlayer(data)).toThrow(/structure/);
    }
    game.destroy();
  });
  it('replays a complete bot match exactly without invoking its controllers', () => {
    const game = createSession({
      mapId: 'courtyard',
      seed: 8751,
      scoreGoal: 1,
      suddenDeathTime: 15,
    });
    game.useBot(0);
    game.startRecording({ checkpointInterval: 120 });
    while (game.getState().phase !== 'matchEnd' && game.tick < 18000) game.step(120);
    expect(game.getState().phase).toBe('matchEnd');
    expect(game.recording).toBeNull();
    const data = game.getRecording()!;
    expect(data.stopReason).toBe('match-end');
    const replay = new ReplayPlayer(JSON.stringify(data));
    replay.step(data.durationTicks);
    expect(replay.status).toBe('ended');
    expect(json(replay.getState())).toEqual(json(game.getState()));
    for (const tick of [data.durationTicks - 1, 0, 61, 200, data.durationTicks]) {
      replay.seek(tick);
      const reference = new ReplayPlayer(data);
      reference.step(Math.max(1, tick));
      if (tick === 0) reference.seek(0);
      expect(json(replay.getState())).toEqual(json(reference.getState()));
    }
    game.destroy();
  }, 30000);

  it('records input cancellation on pause, expiry and control changes, including mid-match starts', () => {
    const game = createSession({ mapId: 'original-four-cogs', mode: 'local', bots: 0, seed: 51 });
    game.step(250);
    const controller = game.acquire(0);
    game.startRecording({ checkpointInterval: 60 });
    controller.submit({ throw: true, move: { x: 1, y: 0 } }, 20);
    game.step(8);
    game.pause();
    game.resume();
    controller.submit({ throw: true }, 4);
    game.step(10);
    game.useScript(0, ({ tick }) => ({ attack: tick % 12 === 0, move: { x: 0, y: 1 } }));
    game.step(100);
    game.takeover(0).release();
    game.step(70);
    const data = game.stopRecording()!;
    expect(data.operations.some((op) => op.type === 'reset')).toBe(true);
    const replay = new ReplayPlayer(JSON.stringify(data));
    replay.step(data.durationTicks);
    expect(json(replay.getState())).toEqual(json(game.getState()));
    replay.seek(80);
    replay.pause();
    const frozen = replay.getState();
    replay.step(20);
    expect(replay.getState()).toEqual(frozen);
    replay.resume();
    replay.step(data.durationTicks);
    expect(json(replay.getState())).toEqual(json(game.getState()));
  });

  it('finalizes before restart and respects an explicit recording length limit', () => {
    const game = createSession();
    game.startRecording({ maxTicks: 15 });
    game.step(30);
    const limited = game.getRecording()!;
    expect(limited.durationTicks).toBe(15);
    expect(limited.stopReason).toBe('limit');
    new ReplayPlayer(limited).step(15);
    game.startRecording();
    game.step(5);
    game.start({ seed: 2 });
    expect(game.getRecording()!.stopReason).toBe('restart');
    new ReplayPlayer(game.getRecording()!).step(5);
  });

  it('rejects incompatible, corrupted and oversized timelines before loading', () => {
    const game = createSession();
    game.startRecording();
    game.step(10);
    const data = game.stopRecording()!;
    expect(() => parseReplay({ ...data, simulationVersion: 'future' })).toThrow(/different/);
    expect(() => parseReplay({ ...data, durationTicks: 20 })).toThrow(/count/);
    data.checkpoints[0].world.state.actors[0].score++;
    expect(() => parseReplay(data)).toThrow(/checksum/);
  });
});
