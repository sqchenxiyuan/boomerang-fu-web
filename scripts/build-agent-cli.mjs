import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundles the headless agent CLI (simulation + QuickJS sandbox) into one Node ESM file.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const result = await build({
  absWorkingDir: ROOT,
  entryPoints: ['src/agent/cli.ts'],
  outfile: 'dist-agent/boomerang-agent.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'linked',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: quiet ? 'warning' : 'info',
  metafile: !quiet,
});
if (!quiet) {
  const bytes = Object.values(result.metafile.outputs).reduce(
    (sum, output) => sum + output.bytes,
    0,
  );
  console.log(`dist-agent/boomerang-agent.mjs (${(bytes / 1024 / 1024).toFixed(1)} MiB with map)`);
}
