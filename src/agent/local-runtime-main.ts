import { serveLocal } from './local-runtime';

// Standalone MUNDI runtime file (node local-runtime.mjs): no CLI, no strategy
// sandbox, no filesystem access; it only joins the runner that spawned it.
serveLocal({
  port: Number(process.env.MUNDI_LOCAL_PORT),
  token: process.env.MUNDI_LOCAL_TOKEN ?? '',
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
