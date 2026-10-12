import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packed = mkdtempSync(join(tmpdir(), 'sdk-freeze-'));

const packing = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'pack-sdk.ts'), packed], {
  stdio: 'inherit',
});
if (packing.status !== 0) throw new Error(`pack-sdk exited with ${packing.status}`);

const readingCopy = join(packed, 'latest');
const packedPackage = JSON.parse(readFileSync(join(readingCopy, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  type: string;
  dependencies: Record<string, string>;
};
const frozen = join(packageRoot, 'test', 'compat', `runtime-${packedPackage.version}`);

function importClosure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(join(readingCopy, 'dist', entry), 'utf8');
  for (const [, relative] of source.matchAll(/from ["']\.\/([^"']+\.js)["']/g)) {
    if (relative) importClosure(relative, seen);
  }
  return seen;
}

rmSync(frozen, { recursive: true, force: true });
mkdirSync(join(frozen, 'dist'), { recursive: true });
for (const file of [...importClosure('server.js')].toSorted()) {
  copyFileSync(join(readingCopy, 'dist', file), join(frozen, 'dist', file));
}
const { name, version, type, dependencies } = packedPackage;
writeFileSync(join(frozen, 'package.json'), `${JSON.stringify({ name, version, type, dependencies }, null, 2)}\n`);
rmSync(packed, { recursive: true, force: true });

process.stdout.write(`froze the ${version} runtime into ${frozen}\n`);
