import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeManifestHash } from '@opsiforce/external-service-sdk/server';

import { runCli } from './support/cli.ts';
import { fixtureFolder, fixtureManifest, serviceFolderWith, trelloManifest } from './support/fixtures.ts';

const fixtures = ['trello', 'incoming-email', 'whatsapp', 'public-api'];

function generatedFor(name: string, manifest: unknown = fixtureManifest(name)): string {
  const files: Record<string, string> = { 'service.json': JSON.stringify(manifest) };
  if (name === 'trello') files['icon.svg'] = readFileSync(join(fixtureFolder('trello'), 'icon.svg'), 'utf8');
  const folder = serviceFolderWith(files);
  const run = runCli(['types', folder, ...(name === 'trello' ? [] : ['--built-in'])]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /wrote service\.types\.ts/);
  return readFileSync(join(folder, 'service.types.ts'), 'utf8');
}

for (const name of fixtures) {
  test(`types writes the committed service.types.ts for the ${name} fixture`, () => {
    const committed = readFileSync(join(fixtureFolder(name), 'service.types.ts'), 'utf8');

    assert.equal(generatedFor(name), committed, `run: external-service-cli types test/fixtures/${name}`);
  });
}

test('types stamps the manifest hash the runtime checks at boot', () => {
  const generated = generatedFor('trello');

  assert.match(generated, new RegExp(`export const manifestHash = '${computeManifestHash(trelloManifest())}';`));
});

test('types gives handler inputs, both configurations and bound names their types', () => {
  const generated = generatedFor('trello');

  assert.match(generated, /export type ListCards = \{\n {2}boardId: string;\n {2}limit: number;\n\};/);
  assert.match(generated, /labels\?: string\[\];/);
  assert.match(generated, /apiKey\?: Secret;/);
  assert.match(generated, /workspace: string;/);
  assert.match(generated, /boardsMode\?: 'selected' \| 'all';/);
  assert.match(generated, /bounds: 'board';/);
  assert.match(generated, /options: 'listBoards';/);
  assert.match(generated, /buttons: 'ping';/);
  assert.match(generated, /inbound: true;/);
});

test('types refuses an invalid manifest and writes nothing', () => {
  const manifest = trelloManifest();
  manifest.$defs.CreateCard.properties.boardId.boundTo = 'boards';
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(manifest) });

  const run = runCli(['types', folder]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /"boards" is not declared in bounds/);
  assert.throws(() => readFileSync(join(folder, 'service.types.ts')));
});

test('the generated types compile and type the Trello handlers, refusing wrong ones', () => {
  const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
  const project = fileURLToPath(new URL('./fixtures/tsconfig.json', import.meta.url));

  const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project], { encoding: 'utf8' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
});
