import { beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '../src/sdk/session';
import { ReplayPlayer, checkpointHash } from '../src/sdk/recording';
import type { ReplayData } from '../src/sdk/recording';
import { ReplayTransport } from '../src/sdk/replay-transport';
import { ReplayTimeline } from '../src/sdk/replay-timeline';

let data: ReplayData;
beforeAll(() => {
  const session = createSession({
    mode: 'bots',
    bots: 4,
    seed: 8751,
    mapId: 'courtyard',
    mapRotation: 'cycle',
    scoreGoal: 2,
    suddenDeathTime: 5,
  });
  session.startRecording({ checkpointInterval: 120 });
  session.step(6000);
  data = session.stopRecording()!;
  session.destroy();
}, 30000);
const hashAt = (tick: number): string => {
  const player = new ReplayPlayer(data);
  player.seek(tick);
  return checkpointHash(player.checkpoint());
};

describe('DOM-free replay transport', () => {
  it('moves by exact signed frames while paused and clamps at both ends', () => {
    const transport = new ReplayTransport(data);
    transport.seek(500);
    transport.stepFrames(-1);
    expect(transport.snapshot()).toMatchObject({ tick: 499, status: 'paused' });
    expect(checkpointHash(transport.player.checkpoint())).toBe(hashAt(499));
    expect(transport.player.drainEvents()).toEqual([]);
    transport.stepFrames(1);
    expect(checkpointHash(transport.player.checkpoint())).toBe(hashAt(500));
    transport.stepFrames(-108000);
    expect(transport.player.tick).toBe(0);
    transport.stepFrames(108000);
    expect(transport.player.status).toBe('ended');
    transport.resume();
    expect(transport.player.tick).toBe(0);
    expect(() => transport.stepFrames(0.5)).toThrow();
  });
  it('scrubs silently, restores the previous play state and cancels to the original cursor', () => {
    const transport = new ReplayTransport(data);
    transport.advance(200);
    transport.beginScrub();
    transport.seek(700);
    transport.advance(10);
    expect(transport.snapshot()).toMatchObject({ tick: 700, status: 'paused', scrubbing: true });
    transport.endScrub(true);
    expect(transport.snapshot()).toMatchObject({ tick: 200, status: 'playing', scrubbing: false });
    transport.pause();
    transport.beginScrub();
    transport.seek(300);
    transport.endScrub();
    expect(transport.snapshot()).toMatchObject({ tick: 300, status: 'paused' });
    transport.resume();
    transport.beginScrub();
    transport.seek(data.durationTicks);
    transport.endScrub();
    expect(transport.player.status).toBe('ended');
    expect(transport.player.drainEvents()).toEqual([]);
  });
  it('wraps arbitrary A-B intervals exactly, including the final frame', () => {
    const transport = new ReplayTransport(data);
    transport.setLoop({ start: 200, end: 260 });
    transport.advance(145);
    expect(transport.snapshot()).toMatchObject({ tick: 225, status: 'playing' });
    expect(checkpointHash(transport.player.checkpoint())).toBe(hashAt(225));
    const exposed = transport.snapshot();
    exposed.loop!.start = 0;
    expect(transport.snapshot().loop?.start).toBe(200);
    expect(() => transport.setLoop({ start: 250, end: 250 })).toThrow();
    expect(transport.snapshot().loop).toEqual({ start: 200, end: 260 });
    transport.setLoop({ start: data.durationTicks - 10, end: data.durationTicks });
    transport.seek(data.durationTicks - 1);
    transport.advance(1);
    expect(transport.snapshot()).toMatchObject({
      tick: data.durationTicks - 10,
      status: 'playing',
    });
    transport.setLoop(null);
    transport.advance(10);
    expect(transport.player.status).toBe('ended');
  });
  it('handles empty recordings and rejects invalid seeks without moving the cursor', () => {
    const session = createSession();
    session.startRecording();
    const transport = new ReplayTransport(session.stopRecording()!);
    transport.resume();
    transport.advance();
    transport.stepFrames(-1);
    expect(transport.snapshot()).toMatchObject({ tick: 0, durationTicks: 0, status: 'ended' });
    expect(() => transport.setLoop({ start: 0, end: 0 })).toThrow();
    expect(() => transport.seek(1)).toThrow();
    expect(transport.player.tick).toBe(0);
    session.destroy();
  });
});

describe('incremental replay event index', () => {
  it('indexes actual event ticks and round/map changes without changing another player', () => {
    const visible = new ReplayTransport(data);
    visible.seek(300);
    visible.pause();
    const index = new ReplayTimeline(data);
    const initial = index.snapshot();
    index.advance(100);
    expect(index.snapshot().progress).toBeCloseTo(100 / data.durationTicks);
    expect(initial.progress).toBe(0);
    while (index.snapshot().status === 'indexing') index.advance(120);
    const result = index.snapshot();
    expect(result.status).toBe('ready');
    expect(result.markers.filter((m) => m.kind === 'round').length).toBeGreaterThan(1);
    expect(new Set(result.markers.map((m) => m.mapId)).size).toBeGreaterThan(1);
    expect(result.markers.some((m) => m.kind === 'death')).toBe(true);
    expect(visible.snapshot()).toMatchObject({ tick: 300, status: 'paused' });
    const expected: string[] = [];
    const reference = new ReplayPlayer(data);
    let round = reference.getState().round;
    while (reference.status !== 'ended') {
      reference.step();
      for (const event of reference.drainEvents()) {
        if (event.type === 'round') {
          const current = reference.getState().round;
          if (round === current) continue;
          round = current;
        }
        if (['round', 'death', 'pickup', 'deflect', 'win'].includes(event.type))
          expected.push(`${reference.tick}:${event.type}:${event.actorId}`);
      }
    }
    expect(result.markers.slice(1).map((m) => `${m.tick}:${m.kind}:${m.actorId}`)).toEqual(
      expected,
    );
    expect(Object.isFrozen(result.markers)).toBe(true);
    expect(Object.isFrozen(result.markers[0])).toBe(true);
  }, 30000);
  it('reports checksum divergence as an indexing error', () => {
    const index = new ReplayTimeline({
      ...data,
      finalHash: data.finalHash === '00000000' ? '11111111' : '00000000',
    });
    index.advance(data.durationTicks);
    expect(index.snapshot().status).toBe('error');
    expect(index.snapshot().error).toContain('diverged');
  }, 30000);
});
