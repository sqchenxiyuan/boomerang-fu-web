import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
let notice =
  '# Third-party notices\n\nThe browser bundles use the following open-source libraries. Game music and sound designs are newly authored procedural compositions.\n';
for (const name of [
  'three',
  'tone',
  'standardized-audio-context',
  'automation-events',
  '@babel/runtime',
  'tslib',
]) {
  const root = resolve('node_modules', name);
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const files = (await readdir(root)).filter((name) => /^licen[cs]e(?:\.|$)/i.test(name));
  if (!files.length) throw new Error(`Missing license for ${name}`);
  notice += `\n## ${name} ${pkg.version} (${pkg.license})\n\n`;
  for (const file of files)
    notice += '```text\n' + (await readFile(resolve(root, file), 'utf8')).trim() + '\n```\n';
}
await writeFile('THIRD_PARTY_NOTICES.md', notice);
await mkdir('public', { recursive: true });
await writeFile('public/THIRD_PARTY_NOTICES.txt', notice);
