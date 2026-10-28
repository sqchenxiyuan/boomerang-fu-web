import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'dist-sdk');
const NAME = '@boomerang-garden/sdk';
const VERSION = '0.3.0';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slash = (value) => value.replaceAll('\\', '/');

async function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next installed npm. */
    }
  }
  throw new Error('Run this script through npm run build:sdk so npm_execpath is available.');
}

function runNode(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

// Only this known generated directory may be replaced. Never derive a deletion from a package name.
if (dirname(OUT) !== ROOT || basename(OUT) !== 'dist-sdk')
  throw new Error('Invalid SDK output directory');
for (const source of ['src/sdk/index.ts', 'src/sdk/browser.ts', 'src/sdk/types.ts'])
  await access(resolve(ROOT, source));
const initialSourceHashes = new Map(
  await Promise.all(
    (await filesIn(resolve(ROOT, 'src'))).map(async (path) => [path, sha256(await readFile(path))]),
  ),
);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: {
    index: 'src/sdk/index.ts',
    browser: 'src/sdk/browser.ts',
    types: 'src/sdk/types.ts',
  },
  outdir: 'dist-sdk/lib',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['three'],
  define: { 'import.meta.env.DEV': 'false' },
  metafile: true,
  minify: false,
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'warning',
});

// Verify the entire transitive core graph, including shared chunks, before packaging it.
const outputs = new Map(
  Object.entries(result.metafile.outputs).map(([path, data]) => [resolve(ROOT, path), data]),
);
const visited = new Set();
function auditCore(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const output = outputs.get(file);
  if (!output) throw new Error(`Missing bundled core dependency: ${file}`);
  for (const input of Object.keys(output.inputs)) {
    if (
      /(?:^|\/)(?:rendering|platform|ui)\//u.test(slash(input)) ||
      input.includes('node_modules/three')
    )
      throw new Error(`Core package imports a browser implementation: ${input}`);
  }
  for (const dependency of output.imports) {
    if (dependency.external)
      throw new Error(`Core package has an external runtime dependency: ${dependency.path}`);
    auditCore(resolve(ROOT, dependency.path));
  }
}
auditCore(resolve(OUT, 'lib/index.js'));

runNode([resolve(ROOT, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.sdk.json']);
// Bundler-mode declarations need explicit ESM extensions when consumed by NodeNext projects.
for (const path of await filesIn(resolve(OUT, 'types'))) {
  if (!path.endsWith('.d.ts')) continue;
  const source = await readFile(path, 'utf8');
  const updated = source.replace(
    /((?:from\s*|import\s*\(\s*)['"])(\.{1,2}\/[^'"]+)(['"])/gu,
    (whole, prefix, specifier, suffix) => {
      return extname(specifier) ? whole : `${prefix}${specifier}.js${suffix}`;
    },
  );
  await writeFile(path, updated);
}

await mkdir(resolve(OUT, 'examples'), { recursive: true });
await copyFile(resolve(ROOT, 'examples/node-bots.mjs'), resolve(OUT, 'examples/node-bots.mjs'));
await copyFile(
  resolve(ROOT, 'examples/duel-controller.js'),
  resolve(OUT, 'examples/duel-controller.js'),
);
await mkdir(resolve(OUT, 'docs'), { recursive: true });
await copyFile(resolve(ROOT, 'docs/sdk-api.md'), resolve(OUT, 'docs/sdk-api.md'));
const manifest = {
  name: NAME,
  version: VERSION,
  private: true,
  type: 'module',
  description:
    'Deterministic Boomerang Garden simulation with external, script and human controllers.',
  main: './lib/index.js',
  types: './types/sdk/index.d.ts',
  exports: {
    '.': { types: './types/sdk/index.d.ts', import: './lib/index.js' },
    './browser': { types: './types/sdk/browser.d.ts', import: './lib/browser.js' },
    './types': { types: './types/sdk/types.d.ts', import: './lib/types.js' },
    './package.json': './package.json',
  },
  files: ['lib', 'types', 'examples', 'docs', 'README.md'],
  sideEffects: false,
  engines: { node: '>=20' },
  dependencies: { three: '^0.180.0' },
};
await writeFile(resolve(OUT, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  resolve(OUT, 'README.md'),
  `# Boomerang Garden SDK\n\nLocal ESM package, version ${VERSION}. This package contains original Web geometry and game logic; it does not need an installed copy of Boomerang Fu.\n\n[完整 API、控制器所有权与人工接管说明](docs/sdk-api.md)\n\n## Core (Node.js or browser)\n\n\`\`\`js\nimport { createSession } from '@boomerang-garden/sdk';\nconst session = createSession({ mapId: 'canal', seed: 41 });\nsession.useBot(0);\nsession.useBot(1);\nsession.step(60);\nconsole.log(session.snapshot());\nsession.destroy();\n\`\`\`\n\nThe core entry imports no DOM, renderer or Three.js runtime. Simulation advances only when the host calls step(). Button samples use move, attack, dash and throw; the session derives edges. acquire() returns a controller handle with expiring samples. useScript() provides a JavaScript controller. takeover() transfers one actor to human input. Use detached snapshots to inspect state.\n\n## Canvas adapter\n\n\`\`\`js\nimport { createBrowserGame } from '@boomerang-garden/sdk/browser';\nconst game = createBrowserGame(document.querySelector('#arena'), {\n  match: { mapId: 'portals', seed: 295 },\n  keyboard: true,\n});\n// Host container must have a visible width and height.\n// game.session exposes the same controls as the core entry.\n// Call game.destroy() when removing the widget.\n\`\`\`\n\nUse a bundler or an import map for the external three dependency. No application CSS, menus, original game assets or debug window hooks are included. TypeScript declarations are exported by the core, browser and types subpaths.\n\n## Complete Node match\n\nAfter installation, run \`node node_modules/@boomerang-garden/sdk/examples/node-bots.mjs\`. It drives both actors with SDK bot controllers until a normal five-point match finishes, then writes a JSON summary.\n\nThis is a local package build, not an npm publication.\n`,
);

const shipped = await filesIn(OUT);
for (const path of shipped) {
  const name = slash(relative(OUT, path));
  if (
    name.includes('analysis/') ||
    name.includes('SteamLibrary') ||
    /\.(?:dll|exe|assets|unity)$/iu.test(name)
  )
    throw new Error(`Unexpected shipped artifact: ${name}`);
  const source = await readFile(path, 'utf8');
  if (/__garden|SteamLibrary|analysis[\\/]derived/u.test(source))
    throw new Error(`Development/original-game reference in package: ${name}`);
}

const pack = JSON.parse(
  runNode([await npmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', OUT], OUT),
)[0];
const tarball = resolve(OUT, pack.filename);
if (dirname(tarball) !== OUT || !isAbsolute(tarball))
  throw new Error('Unexpected npm pack destination');
const bytes = await readFile(tarball);
const sourceHashes = {};
for (const file of Object.keys(result.metafile.inputs)) {
  const path = resolve(ROOT, file);
  const hash = sha256(await readFile(path));
  if (hash !== initialSourceHashes.get(path))
    throw new Error(`Source changed during SDK build; rebuild after edits finish: ${file}`);
  sourceHashes[slash(file)] = hash;
}
const report = {
  name: NAME,
  version: VERSION,
  createdAt: new Date().toISOString(),
  tarball,
  sha256: sha256(bytes),
  size: bytes.length,
  npmIntegrity: pack.integrity,
  coreRuntimeFiles: [...visited].map((file) => slash(relative(OUT, file))),
  files: pack.files.map((file) => ({ path: file.path, size: file.size })),
  sourceHashes,
};
await writeFile(resolve(OUT, 'build-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      name: NAME,
      version: VERSION,
      tarball,
      sha256: report.sha256,
      size: report.size,
      files: report.files.length,
      manifest: resolve(OUT, 'build-manifest.json'),
    },
    null,
    2,
  ),
);
