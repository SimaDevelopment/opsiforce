import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.resolve('@opsiforce/external-service-sdk/package.json')));
const sourcePackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};
const tarballName = `external-service-sdk-${sourcePackage.version}.tgz`;

let out: string;
let unpacked: string;
let packRun: { status: number | null; stdout: string; stderr: string };

function filesUnder(folder: string, prefix = ''): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(folder, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  );
}

function pack(folder: string) {
  return spawnSync(process.execPath, [join(packageRoot, 'scripts', 'pack-sdk.ts'), folder], { encoding: 'utf8' });
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

before(() => {
  out = mkdtempSync(join(tmpdir(), 'sdk-pack-'));
  packRun = pack(out);
  unpacked = mkdtempSync(join(tmpdir(), 'sdk-unpacked-'));
  if (existsSync(join(out, tarballName))) {
    spawnSync('tar', ['-xzf', join(out, tarballName), '-C', unpacked]);
  }
});

test('packs a tarball named after the SDK version', () => {
  assert.equal(packRun.status, 0, packRun.stdout + packRun.stderr);
  assert.ok(existsSync(join(out, tarballName)), `expected ${tarballName} in ${readdirSync(out).join(', ')}`);
});

test('the tarball holds compiled JavaScript and declarations, never TypeScript source', () => {
  const files = filesUnder(join(unpacked, 'package'));

  assert.ok(files.includes('dist/index.js'));
  assert.ok(files.includes('dist/index.d.ts'));
  assert.ok(files.includes('dist/testing.js'));
  assert.ok(files.includes('dist/cli.js'));
  assert.deepEqual(
    files.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')),
    []
  );
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    assert.doesNotMatch(
      readFileSync(join(unpacked, 'package', file), 'utf8'),
      /from ['"]\.{1,2}\/[^'"]*\.ts['"]/,
      file
    );
  }
});

test('the tarball carries the README, the CHANGELOG and the manifest schema', () => {
  const files = filesUnder(join(unpacked, 'package'));

  for (const file of ['README.md', 'CHANGELOG.md', 'service.schema.json', 'package.json']) {
    assert.ok(files.includes(file), `missing ${file}`);
  }
  assert.match(
    readFileSync(join(unpacked, 'package', 'CHANGELOG.md'), 'utf8'),
    new RegExp(`## ${sourcePackage.version}`)
  );
});

test('its package.json points every export and the CLI at the compiled files', () => {
  const packed = JSON.parse(readFileSync(join(unpacked, 'package', 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    exports: Record<string, string | { types: string; default: string }>;
    devDependencies?: unknown;
  };

  assert.equal(packed.name, '@opsiforce/external-service-sdk');
  assert.equal(packed.version, sourcePackage.version);
  assert.equal(packed.bin['external-service-cli'], './dist/cli.js');
  assert.deepEqual(packed.exports['.'], { types: './dist/index.d.ts', default: './dist/index.js' });
  assert.deepEqual(packed.exports['./testing'], { types: './dist/testing.d.ts', default: './dist/testing.js' });
  assert.equal(packed.exports['./service.schema.json'], './service.schema.json');
  assert.equal(packed.devDependencies, undefined);
});

test('the platform-only entry points stay out of the packed exports', () => {
  const packed = JSON.parse(readFileSync(join(unpacked, 'package', 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };

  assert.equal(packed.exports['./platform'], undefined);
  assert.equal(packed.exports['./forms'], undefined);
});

test('its dependencies name the exact versions the SDK was tested with', () => {
  const packed = JSON.parse(readFileSync(join(unpacked, 'package', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const requireFromSdk = createRequire(join(packageRoot, 'package.json'));
  const installed = Object.fromEntries(
    Object.keys(sourcePackage.dependencies).map((name) => [
      name,
      (JSON.parse(readFileSync(requireFromSdk.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version,
    ])
  );

  assert.deepEqual(packed.dependencies, installed);
  for (const version of Object.values(packed.dependencies)) assert.match(version, /^\d+\.\d+\.\d+/);
});

test('packing the same source twice gives the same bytes', () => {
  const again = mkdtempSync(join(tmpdir(), 'sdk-pack-again-'));
  const secondRun = pack(again);

  assert.equal(secondRun.status, 0, secondRun.stdout + secondRun.stderr);
  assert.equal(sha256(join(again, tarballName)), sha256(join(out, tarballName)));
});

test('leaves an unpacked read-only reading copy beside the tarball', () => {
  assert.ok(existsSync(join(out, 'latest', 'README.md')));
  assert.ok(existsSync(join(out, 'latest', 'dist', 'index.d.ts')));
});
