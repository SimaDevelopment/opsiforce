import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeManifestHash } from '@opsiforce/external-service-sdk/server';

import { runCli } from './support/cli.ts';
import { fixtureFolder, fixtureManifest, serviceFolderWith, trelloManifest } from './support/fixtures.ts';

const fixtures = ['trello', 'whatsapp', 'github-sdk2'];

function generatedFor(name: string, manifest: unknown = fixtureManifest(name)): string {
  const files: Record<string, string> = { 'service.json': JSON.stringify(manifest) };
  if (name === 'trello') files['icon.svg'] = readFileSync(join(fixtureFolder('trello'), 'icon.svg'), 'utf8');
  const folder = serviceFolderWith(files);
  const run = runCli(['types', folder]);
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

test('types stamps the manifest hash defineService checks', () => {
  const generated = generatedFor('trello');

  assert.match(generated, new RegExp(`export const manifestHash = '${computeManifestHash(trelloManifest())}';`));
});

test('types gives both configurations, the settings, the Event types and the form calls their types', () => {
  const generated = generatedFor('trello');

  assert.match(generated, /apiKey\?: Secret;/);
  assert.match(generated, /workspace: string;/);
  assert.match(generated, /boardsMode\?: 'selected' \| 'all';/);
  assert.match(generated, /export type Setting = 'workspace' \| 'boardsMode' \| 'boardIds';/);
  assert.match(generated, /export type EventType = 'card\.moved';/);
  assert.match(generated, /options: 'listBoards';/);
  assert.match(generated, /buttons: 'ping';/);
});

test('types refuses an invalid manifest and writes nothing', () => {
  const manifest = trelloManifest();
  manifest.projectForm[2].visibleWhen.field = 'mode';
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(manifest) });

  const run = runCli(['types', folder]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /"mode" is not a field at the same level/);
  assert.throws(() => readFileSync(join(folder, 'service.types.ts')));
});

test('the generated types compile with the services that use them', () => {
  const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
  const project = fileURLToPath(new URL('./fixtures/tsconfig.json', import.meta.url));

  const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project], { encoding: 'utf8' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
});
