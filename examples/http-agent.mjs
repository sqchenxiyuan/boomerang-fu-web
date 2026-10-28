import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** An intentionally small state-based pursuit policy, not a connected language model. */
export function decide(observation) {
  const { state, actorId, tick } = observation;
  const me = state.actors.find((actor) => actor.id === actorId);
  if (!me?.alive) return {};
  const target = state.actors
    .filter((actor) => actor.alive && actor.id !== actorId)
    .sort(
      (a, b) =>
        Math.hypot(a.position.x - me.position.x, a.position.y - me.position.y) -
        Math.hypot(b.position.x - me.position.x, b.position.y - me.position.y),
    )[0];
  if (!target) return {};
  const dx = target.position.x - me.position.x,
    dy = target.position.y - me.position.y;
  const distance = Math.hypot(dx, dy),
    length = Math.max(0.001, distance);
  return {
    move: { x: dx / length, y: dy / length },
    attack: distance < 1.5,
    dash: distance > 3 && tick % 120 < 6,
    throw: me.armed ? distance > 2 && tick % 90 < 48 : true,
  };
}

export function createAgentServer(policy = decide) {
  return createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/action') {
        response.writeHead(404).end();
        return;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const observation = JSON.parse(Buffer.concat(chunks).toString());
      if (
        observation.protocol !== 'boomerang-garden.agent.v1' ||
        !Number.isInteger(observation.tick) ||
        !Number.isInteger(observation.actorId) ||
        !observation.state?.actors
      )
        throw new Error('Invalid observation');
      const action = await policy(observation);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          protocol: observation.protocol,
          tick: observation.tick,
          actorId: observation.actorId,
          action,
        }),
      );
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createAgentServer();
  server.listen(port, '127.0.0.1', () =>
    console.log(`Example agent: http://127.0.0.1:${port}/action`),
  );
}
