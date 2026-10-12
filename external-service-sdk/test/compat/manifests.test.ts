import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkServiceManifest, type ServiceOrigin } from '@opsiforce/external-service-sdk';

const corpusFolder = join(dirname(fileURLToPath(import.meta.url)), 'manifests');
const builtInsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'external-services');

const origins: Record<string, ServiceOrigin> = { 'built-in': 'built_in', custom: 'custom' };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const corpus = readdirSync(corpusFolder)
  .filter((file) => file.endsWith('.json'))
  .toSorted()
  .map((file) => {
    const origin = origins[file.split('.')[0] ?? ''];
    if (!origin) throw new Error(`${file} must start with built-in. or custom.`);
    return { file, origin, manifest: readJson(join(corpusFolder, file)) };
  });

for (const { file, origin, manifest } of corpus) {
  test(`today's check still accepts ${file}, a manifest an earlier release accepted`, () => {
    const check = checkServiceManifest(manifest, { origin });

    assert.deepEqual(
      check.problems.filter((problem) => problem.severity === 'error'),
      []
    );
    assert.equal(check.ok, true);
  });
}

test('every committed Built-in manifest is in the corpus, so a later release keeps accepting it', () => {
  const builtIns = readdirSync(builtInsFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(builtInsFolder, entry.name, 'service.json'))
    .filter((path) => existsSync(path));

  assert.ok(builtIns.length > 0);
  for (const path of builtIns) {
    const manifest = readJson(path);
    assert.ok(
      corpus.some((entry) => JSON.stringify(entry.manifest) === JSON.stringify(manifest)),
      `${path} is not in test/compat/manifests; copy it there as built-in.<name>.json`
    );
  }
});
