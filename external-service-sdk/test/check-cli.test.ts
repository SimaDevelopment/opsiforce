import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from './support/cli.ts';
import { fixtureFolder, serviceFolderWith, trelloManifest } from './support/fixtures.ts';
import { githubManifest } from './support/sdk2.ts';

const trelloIcon = readFileSync(join(fixtureFolder('trello'), 'icon.svg'), 'utf8');

test('check accepts the Trello example folder', () => {
  const run = runCli(['check', fixtureFolder('trello')]);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /^error/m);
  assert.match(run.stdout, /service\.json: 0 errors, 0 warnings/);
});

test('check accepts an sdk 2 manifest whose Event types have only a title and a description', () => {
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(githubManifest()) });

  const run = runCli(['check', folder]);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /service\.json: 0 errors, 0 warnings/);
});

for (const key of ['operations', 'bounds', '$defs']) {
  test(`check refuses ${key}`, () => {
    const folder = serviceFolderWith({ 'service.json': JSON.stringify({ ...githubManifest(), [key]: {} }) });

    const run = runCli(['check', folder]);

    assert.equal(run.status, 1);
    assert.ok(run.stdout.includes(`${key}: SDK 2 has no Operations; enforce this in your Service policy`), run.stdout);
  });
}

test('check refuses an SDK 1 manifest', () => {
  const folder = serviceFolderWith({ 'service.json': JSON.stringify({ ...githubManifest(), sdk: 1 }) });

  const run = runCli(['check', folder]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /^error\s+sdk: sdk must be 2$/m);
});

test('check exits 1 and names the path of each error', () => {
  const manifest = trelloManifest();
  manifest.projectForm[2].visibleWhen.field = 'mode';
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(manifest), 'icon.svg': trelloIcon });

  const run = runCli(['check', folder]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /^error\s+projectForm\[2\]\.visibleWhen: "mode" is not a field at the same level$/m);
  assert.match(run.stdout, /service\.json: 1 error, 0 warnings/);
});

test('check refuses a folder without service.json', () => {
  const run = runCli(['check', serviceFolderWith({})]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /service\.json not found/);
});

test('check refuses a service.json that is not JSON', () => {
  const run = runCli(['check', serviceFolderWith({ 'service.json': '{ "sdk": 2,' })]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /service\.json is not valid JSON/);
});

test('check refuses a missing, oversized or unsafe icon', () => {
  const manifest = JSON.stringify(trelloManifest());
  const cases: [string, Record<string, string>, RegExp][] = [
    ['missing', {}, /icon file .*icon\.svg not found/],
    ['oversized', { 'icon.svg': `<svg>${' '.repeat(33 * 1024)}</svg>` }, /icon is \d+ bytes; the limit is 32768/],
    ['script', { 'icon.svg': '<svg><script>alert(1)</script></svg>' }, /icon contains a <script> element/],
    ['handler', { 'icon.svg': '<svg onload="alert(1)"></svg>' }, /icon contains an event handler attribute/],
    [
      'external link',
      { 'icon.svg': '<svg><use href="https://evil.test/a.svg#x"/></svg>' },
      /icon links outside the icon/,
    ],
    ['not svg', { 'icon.svg': '<html></html>' }, /icon is not an SVG document/],
  ];
  for (const [name, files, message] of cases) {
    const run = runCli(['check', serviceFolderWith({ 'service.json': manifest, ...files })]);

    assert.equal(run.status, 1, name);
    assert.match(run.stdout, message, name);
  }
});

test('check accepts an icon that links only inside itself', () => {
  const icon =
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p"/></defs><use href="#p"/></svg>';
  const run = runCli([
    'check',
    serviceFolderWith({ 'service.json': JSON.stringify(trelloManifest()), 'icon.svg': icon }),
  ]);

  assert.equal(run.status, 0, run.stdout);
});

test('an unknown command prints the usage', () => {
  const run = runCli(['publish']);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /Unknown command: publish/);
  assert.match(run.stderr, /external-service-cli check/);
});
