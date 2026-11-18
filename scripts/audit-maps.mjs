// Map audit for the gallery: static layout checks plus bot rounds per map.
//   npm run audit:maps [-- --rounds 6] [-- --only original-island]
// Writes src/devtools/map-audit-data.json (keyed by map id, stamped with the
// simulation and map data versions it was measured on).
import { writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const rounds = Number(flag('--rounds', 6));
const only = flag('--only', null);
const bundle = await esbuild.build({
  stdin: {
    contents: `export { MAPS } from './src/core/arena';
export { auditMap, botAudit } from './src/devtools/map-audit';
export { SIMULATION_VERSION, MAP_DATA_VERSION } from './src/sdk/recording';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'warning',
});
const lib = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const file = join(root, 'src/devtools/map-audit-data.json');
const previous = only
  ? JSON.parse(await readFile(file, 'utf8').catch(() => '{"maps":{}}'))
  : { maps: {} };
const maps = { ...previous.maps };
for (const map of lib.MAPS) {
  if (only && map.id !== only) continue;
  const started = performance.now();
  const audit = lib.auditMap(map.id);
  const bots = map.tutorial ? null : lib.botAudit(map.id, rounds, 7);
  maps[map.id] = { static: audit, bots };
  const issues = audit.findings.filter((f) => f.level !== 'info').length;
  console.log(
    `${map.id.padEnd(30)} ${String(Math.round(performance.now() - started)).padStart(6)} ms  issues ${issues}` +
      (bots
        ? `  round ${bots.meanSeconds.toFixed(0)}s self ${bots.selfKills}/${bots.rounds} stuck ${bots.stuckSeconds.toFixed(1)}s`
        : ''),
  );
}
await writeFile(
  file,
  JSON.stringify(
    {
      format: 'map-audit-v1',
      simulationVersion: lib.SIMULATION_VERSION,
      mapDataVersion: lib.MAP_DATA_VERSION,
      rounds,
      maps,
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${Object.keys(maps).length} maps → src/devtools/map-audit-data.json`);
