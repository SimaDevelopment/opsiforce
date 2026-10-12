import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from './support/cli.ts';
import { fixtureFolder, serviceFolderWith, trelloManifest } from './support/fixtures.ts';

const trelloIcon = readFileSync(join(fixtureFolder('trello'), 'icon.svg'), 'utf8');

test('check accepts the Trello example folder', () => {
  const run = runCli(['check', fixtureFolder('trello')]);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /^error/m);
  assert.match(run.stdout, /service\.json: 0 errors, 0 warnings/);
});

for (const builtIn of ['incoming-email', 'whatsapp', 'public-api']) {
  test(`check --built-in accepts the planned ${builtIn} manifest`, () => {
    const run = runCli(['check', fixtureFolder(builtIn), '--built-in']);

    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /service\.json: 0 errors/);
  });
}

test('check exits 1 and names the path of each error', () => {
  const manifest = trelloManifest();
  manifest.$defs.CreateCard.properties.boardId.boundTo = 'boards';
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(manifest), 'icon.svg': trelloIcon });

  const run = runCli(['check', folder]);

  assert.equal(run.status, 1);
  assert.match(
    run.stdout,
    /^error\s+\$defs\.CreateCard\.properties\.boardId\.boundTo: "boards" is not declared in bounds$/m
  );
  assert.match(run.stdout, /service\.json: 1 error, 0 warnings/);
});

test('check warns but passes on a write Operation with no bound', () => {
  const run = runCli(['check', fixtureFolder('public-api')]);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^warning\s+operations\.create_project: write Operation with no bound/m);
  assert.match(run.stdout, /^warning\s+operations\.reset_test_project: destructive Operation with no bound/m);
  assert.doesNotMatch(run.stdout, /list_agents/);
  assert.match(run.stdout, /service\.json: 0 errors, 2 warnings/);
});

test('check refuses an unbound Event type only for a Built-in External Service', () => {
  const manifest = trelloManifest();
  delete manifest.events['card.moved'].data.properties.boardId.boundTo;
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(manifest), 'icon.svg': trelloIcon });

  const custom = runCli(['check', folder]);
  const builtIn = runCli(['check', folder, '--built-in']);

  assert.equal(custom.status, 0, custom.stdout);
  assert.equal(builtIn.status, 1, builtIn.stdout);
  assert.match(
    builtIn.stdout,
    /^error\s+events\["card\.moved"\]\.data: a Built-in External Service binds every Event type/m
  );
});

test('check refuses a folder without service.json', () => {
  const run = runCli(['check', serviceFolderWith({})]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /service\.json not found/);
});

test('check refuses a service.json that is not JSON', () => {
  const run = runCli(['check', serviceFolderWith({ 'service.json': '{ "sdk": 1,' })]);

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
