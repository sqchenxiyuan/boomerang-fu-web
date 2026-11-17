import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL, ENGINE_ID } from '../src/agent/contract';
import { AgentRuntime } from '../src/agent/runtime';
import { MundiHost, type HostPort, type HostView, type Playback } from '../src/mundi/host';
import { FramePacer } from '../src/mundi/pacer';

/** A pacer on a fake clock: by default each request finds exactly one more frame due. */
function fakePacer(step = 1000 / 60): FramePacer {
  let now = 0;
  return new FramePacer({
    now: () => (now += step),
    schedule: (callback) => setTimeout(callback, 0),
    hidden: () => false,
    onVisibility: () => () => {},
  });
}
function fakeView() {
  const log: string[] = [];
  const playback: Playback[] = [];
  const view: HostView = {
    reset: () => void log.push('reset'),
    advanced: () => void log.push('advanced'),
    playback: (state) => void playback.push(state),
    audio: () => ({ phase: 'ready', enabled: true }),
    appearance: (players) => void log.push(`appearance:${JSON.stringify(players)}`),
    settle: async () => void log.push('settle'),
    dispose: () => void log.push('dispose'),
  };
  return { view, log, playback };
}
/** Platform side of a port: one request at a time, like the platform bridge. */
function client(port: MessagePort) {
  let serial = 0;
  const waiting = new Map<number, (data: { result?: unknown; error?: string }) => void>();
  port.onmessage = ({ data }) => waiting.get(data.id)?.(data);
  return {
    manifest: new Promise<{ result?: Record<string, unknown> }>((resolve) =>
      waiting.set(0, resolve as never),
    ),
    send(method: string, params: unknown = {}, transfer: Transferable[] = []) {
      const id = ++serial;
      return new Promise<{ result?: any; error?: string }>((resolve) => {
        waiting.set(id, resolve);
        port.postMessage({ id, method, params }, transfer);
      });
    },
    control(message: unknown) {
      port.postMessage(message);
    },
    close: () => port.close(),
  };
}
function setup(clockStep?: number) {
  const runtime = new AgentRuntime({ events: true });
  const pacer = fakePacer(clockStep);
  const { view, log, playback } = fakeView();
  const host = new MundiHost(runtime, pacer, view, ENGINE_ID);
  const channel = new MessageChannel();
  host.connect(channel.port2 as unknown as HostPort);
  return { host, runtime, pacer, log, playback, platform: client(channel.port1) };
}
const act = (patch: Record<string, unknown> = {}) => ({
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  throw: false,
  dash: false,
  melee: false,
  ...patch,
});

describe('MUNDI embed host (arkena.game.v1)', () => {
  it('announces the protocol and capabilities on connect', async () => {
    const { platform, host } = setup();
    const { result } = await platform.manifest;
    expect(result).toMatchObject({
      protocol: AGENT_PROTOCOL,
      engineId: ENGINE_ID,
      tickHz: 60,
      directRunner: true,
      pacedStep: true,
      observations: true,
      stepObservations: true,
      presentEnding: true,
    });
    expect(host.connect(new MessageChannel().port1 as unknown as HostPort)).toBe(false);
    host.dispose();
  });

  it('validates reset like the platform host and runs every match-* mode as a match', async () => {
    const { platform, host, log } = setup();
    expect((await platform.send('reset', { seed: 1.5, mode: 'round' })).error).toBe(
      'Invalid game reset',
    );
    expect((await platform.send('reset', { seed: 1, mode: 'duel' })).error).toBe(
      'Invalid game reset',
    );
    expect(
      (await platform.send('reset', { seed: 1, mode: 'round', characters: ['Milk', 'Milk'] }))
        .error,
    ).toBe('Invalid characters');
    const { result } = await platform.send('reset', {
      seed: 42,
      mode: 'match-seven',
      characters: ['Banana', 'Coffee'],
    });
    expect(result).toMatchObject({ engine: ENGINE_ID, tick: 0, round: 1, done: false });
    expect(result.characters).toEqual(['Banana', 'Coffee']);
    expect(log).toContain('reset');
    host.dispose();
  });

  it('checks step shapes and steps exact frames', async () => {
    const { platform, host } = setup();
    await platform.send('reset', { seed: 7, mode: 'round' });
    expect((await platform.send('step', { actions: [act()], frames: 3 })).error).toBe(
      'Invalid step',
    );
    expect((await platform.send('step', { actions: [act(), act()], frames: 7 })).error).toBe(
      'Invalid step',
    );
    expect(
      (await platform.send('pacedStep', { actions: [act(), act()], frames: 6, speed: 3 })).error,
    ).toBe('Invalid speed');
    const { result } = await platform.send('step', { actions: [act(), act()], frames: 4 });
    expect(result.tick).toBe(4);
    const observations = await platform.send('observations');
    expect(observations.result).toHaveLength(2);
    expect(observations.result[0].self.id).toBe(0);
    expect(observations.result[1].self.id).toBe(1);
    host.dispose();
  });

  it('paces live play in real time and matches the headless CLI frame for frame', async () => {
    const { platform, host } = setup();
    const cli = new AgentRuntime();
    await platform.send('reset', { seed: 9001, mode: 'round', characters: ['Bread', 'Milk'] });
    cli.reset({ seed: 9001, mode: 'round', characters: ['Bread', 'Milk'] });
    const script = [
      [act({ moveX: 1, throw: true }), act({ moveX: -1 })],
      [act({ moveX: 1, throw: false }), act({ moveY: 1, dash: true })],
      [act({ moveY: -1, melee: true }), act({ moveX: -1, throw: true })],
      [act({ aimX: 1, aimY: 0.4 }), act({ moveX: -1, throw: false })],
    ];
    for (let i = 0; i < 60; i++) {
      const pair = script[i % script.length];
      const { result } = await platform.send('pacedStep', {
        actions: pair,
        frames: 6,
        speed: 1,
        observations: true,
      });
      const expected = cli.step(pair, 6);
      expect(result.advanced).toBe(expected.done ? result.advanced : 6);
      expect(result.frame).toEqual(expected);
      if (expected.done) break;
      expect(result.observations[1]).toEqual(cli.observe(1));
    }
    host.dispose();
  });

  it('replays action batches of up to 30 decisions', async () => {
    const { platform, host } = setup();
    await platform.send('reset', { seed: 5, mode: 'match' });
    expect((await platform.send('replay', { actions: [] })).error).toBe('Invalid replay batch');
    const pairs = Array.from({ length: 30 }, () => [act({ moveX: 1 }), act({ moveX: -1 })]);
    const { result } = await platform.send('replay', { actions: pairs });
    expect(result).toHaveLength(30);
    expect(result.at(-1).tick).toBe(180);
    expect((await platform.send('replay', { actions: [...pairs, pairs[0]] })).error).toBe(
      'Invalid replay batch',
    );
    host.dispose();
  });

  it('lets a direct runner port step and observe only', async () => {
    const { platform, host } = setup();
    await platform.send('reset', { seed: 11, mode: 'round' });
    const channel = new MessageChannel();
    expect((await platform.send('connectRunner', {}, [channel.port2])).result).toBe(true);
    const runner = client(channel.port1);
    expect((await runner.send('reset', { seed: 1, mode: 'round' })).error).toBe(
      'Unsupported runner command',
    );
    expect((await runner.send('observations')).result).toHaveLength(2);
    const step = await runner.send('pacedStep', {
      actions: [act(), act()],
      frames: 6,
      speed: 2,
      observations: true,
    });
    expect(step.result.advanced).toBe(6);
    expect(step.result.observations).toHaveLength(2);
    expect((await platform.send('detachRunner')).result).toBe(true);
    runner.close();
    host.dispose();
  });

  it('refuses overlapping commands and stops cleanly when paused', async () => {
    // A slow clock keeps the paced step waiting, so the second command overlaps it.
    const { platform, host, pacer } = setup(2);
    await platform.send('reset', { seed: 3, mode: 'round' });
    const first = platform.send('pacedStep', { actions: [act(), act()], frames: 6, speed: 1 });
    const second = await platform.send('snapshot');
    expect(second.error).toBe('Game command already in flight');
    expect((await first).result.advanced).toBe(6);
    platform.control({ control: 'pause', paused: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pacer.paused).toBe(true);
    const paused = await platform.send('pacedStep', {
      actions: [act(), act()],
      frames: 6,
      speed: 1,
    });
    expect(paused.result.advanced).toBe(0);
    expect(paused.result.frame.tick).toBe(6);
    host.dispose();
  });

  it('presents the ending after a result without changing it', async () => {
    const { platform, host, runtime, log } = setup();
    await platform.send('reset', { seed: 21, mode: 'round' });
    // Nobody acts; the round ends on the sudden-death boundary.
    let frame: any = null;
    for (let i = 0; i < 2000 && !frame?.done; i++)
      frame = (
        await platform.send('replay', { actions: Array(30).fill([act(), act()]) })
      ).result.at(-1);
    expect(frame.done).toBe(true);
    const before = runtime.snapshot();
    const { result } = await platform.send('presentEnding');
    expect(result.frames).toBeGreaterThan(0);
    expect(log.at(-1)).toBe('settle');
    expect(runtime.snapshot()).toMatchObject({
      tick: before.tick,
      scores: before.scores,
      done: true,
      winner: before.winner,
    });
    host.dispose();
  }, 60000);

  it('forwards display-only appearance and the sound toggle', async () => {
    const { platform, host, log } = setup();
    expect((await platform.send('appearance', { players: [null, { name: '小绿' }] })).result).toBe(
      true,
    );
    expect(log.at(-1)).toBe('appearance:[null,{"name":"小绿"}]');
    expect((await platform.send('audio')).result).toEqual({ phase: 'ready', enabled: true });
    expect((await platform.send('dispose')).result).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(log).toContain('dispose');
    host.dispose();
  });
});
