import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { ENGINE_ID, LOCAL_PROTOCOL } from '../src/agent/contract';
import { AgentRuntime } from '../src/agent/runtime';
import { serveLocal } from '../src/agent/local-runtime';

/** Over the wire values are JSON: -0 arrives as 0. */
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** The MUNDI runner's side of mundi.local.v1: listen, authenticate, request. */
async function runner(token: string) {
  let socket: Socket | null = null;
  const replies: Array<(value: any) => void> = [];
  let hello: (value: any) => void = () => {};
  const helloReceived = new Promise<any>((resolve) => (hello = resolve));
  const server = createServer((connection) => {
    socket = connection;
    const lines = createInterface({ input: connection });
    let first = true;
    lines.on('line', (line) => {
      const data = JSON.parse(line);
      if (first) {
        first = false;
        hello(data);
      } else replies.shift()?.(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const request = (id: number, method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      replies.push(resolve);
      socket!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  return { port, token, helloReceived, request, close: () => server.close() };
}

describe('mundi.local.v1 runtime (pinned by the platform)', () => {
  it('authenticates, answers reset/advance/snapshot with frame + observations, and quits', async () => {
    const side = await runner('secret-token');
    const done = serveLocal({ port: side.port, token: side.token });
    expect(await side.helloReceived).toEqual({
      hello: LOCAL_PROTOCOL,
      token: 'secret-token',
      engine: ENGINE_ID,
    });
    const reset = await side.request(1, 'reset', {
      seed: 77,
      mode: 'match-short',
      characters: ['Milk', 'Bread'],
    });
    expect(reset.result.frame).toMatchObject({ engine: ENGINE_ID, tick: 0, round: 1 });
    expect(reset.result.observations).toHaveLength(2);
    const reference = new AgentRuntime();
    reference.reset({ seed: 77, mode: 'match', characters: ['Milk', 'Bread'] });
    const pair = [
      { moveX: 1, moveY: 0, aimX: 1, aimY: 0, throw: true, dash: false, melee: false },
      { moveX: -1, moveY: 0, aimX: -1, aimY: 0, throw: false, dash: false, melee: false },
    ];
    for (let i = 0; i < 20; i++) {
      const step = await side.request(2 + i, 'advance', { actions: pair });
      expect(step.result.frame).toEqual(json(reference.step(pair, 6)));
      expect(step.result.observations[0]).toEqual(json(reference.observe(0)));
    }
    expect((await side.request(40, 'snapshot')).result.frame.tick).toBe(120);
    expect((await side.request(41, 'step', { actions: pair, frames: 1 })).error).toBe(
      'Unknown local runtime method',
    );
    expect((await side.request(42, 'reset', { seed: 1, mode: 'duel' })).error).toBe(
      'mode must be round or match',
    );
    expect((await side.request(43, 'quit')).result).toBe(true);
    await done;
    side.close();
  });

  it('refuses to start without a runner port', async () => {
    await expect(serveLocal({ port: 0, token: '' })).rejects.toThrow('MUNDI_LOCAL_PORT');
  });
});
