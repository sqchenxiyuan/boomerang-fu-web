// Builds the MUNDI embed (mundi.html) into an immutable, versioned folder:
// dist-mundi/<engine id>/ with index.html, hashed assets and SOURCE.json
// (engine, protocol, source commit, per-file SHA-256). The platform copies the
// folder verbatim to /games/<engine id>/; relative URLs keep it location-free.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { build } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const contract = await esbuild.build({
  stdin: {
    contents:
      "import { ENGINE_ID, AGENT_PROTOCOL } from './src/agent/contract'; export { ENGINE_ID, AGENT_PROTOCOL };",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'warning',
});
const { ENGINE_ID, AGENT_PROTOCOL } = await import(
  'data:text/javascript;base64,' + Buffer.from(contract.outputFiles[0].text).toString('base64')
);
const outDir = join(root, 'dist-mundi', ENGINE_ID);
await rm(outDir, { recursive: true, force: true });
await build({
  root,
  configFile: false,
  base: './',
  logLevel: process.argv.includes('--quiet') ? 'warn' : 'info',
  publicDir: false,
  build: {
    target: 'es2022',
    outDir,
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: { index: join(root, 'mundi.html') },
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
await rename(join(outDir, 'mundi.html'), join(outDir, 'index.html'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
async function list(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? list(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return files.flat();
}
const files = {};
for (const file of (await list(outDir)).sort()) {
  const name = relative(outDir, file).split('\\').join('/');
  files[name] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
const source = {
  format: 'boomerang-web-build-v1',
  engine: ENGINE_ID,
  protocol: AGENT_PROTOCOL,
  repository: 'https://github.com/sqchenxiyuan/boomerang-fu-web',
  commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  files,
};
await writeFile(join(outDir, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
console.log(`${ENGINE_ID}: ${Object.keys(files).length} files → ${relative(root, outDir)}`);
