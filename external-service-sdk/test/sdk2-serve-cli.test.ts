import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mintCallerIdentity } from '@opsiforce/external-service-sdk/server';

import { runCli, startCli } from './support/cli.ts';
import { serviceFolderWith } from './support/fixtures.ts';
import { githubManifest } from './support/sdk2.ts';

const gatewayKey = 'gw-dev-pod-key-0123456789';
const sdkEntry = fileURLToPath(import.meta.resolve('@opsiforce/external-service-sdk'));

function sdk2Folder(): string {
  return serviceFolderWith({
    'service.json': JSON.stringify(githubManifest(), null, 2),
    'service.ts': [
      `import { allowAll, defineService, route } from ${JSON.stringify(sdkEntry)};`,
      "import manifest from './service.json' with { type: 'json' };",
      '',
      'export default defineService({',
      '  manifest,',
      "  routes: [route('GET /api/v3/meta', { summary: 'Meta', allowedBy: [], check: allowAll, handle: () => Response.json({}) })],",
      '});',
      '',
    ].join('\n'),
  });
}

test('types writes the sdk 2 configurations, settings and Event types', () => {
  const folder = sdk2Folder();

  const run = runCli(['types', folder]);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  const types = readFileSync(join(folder, 'service.types.ts'), 'utf8');
  assert.match(types, /export type Setting = 'repositories' \| 'coAuthor' \| 'apiToken';/);
  assert.match(types, /export type EventType = 'issue\.opened';/);
  assert.match(types, /privateKey: Secret;/);
  assert.doesNotMatch(types, /operations/);
});

test('serve answers GET /.well-known/opsiforce for an sdk 2 service', async (t) => {
  const running = startCli(['serve', sdk2Folder(), '--port', '0'], { SERVICE_GATEWAY_API_KEY: gatewayKey });
  t.after(() => running.stop());
  const [, port] = await running.waitFor(/listening on port (\d+) \(SDK 2/);
  const identity = mintCallerIdentity({ kind: 'platform', tenantId: 'tenant_test' }, gatewayKey);

  const described = await fetch(`http://127.0.0.1:${port}/.well-known/opsiforce`, {
    headers: { 'x-opsiforce-caller': identity },
  });
  const unidentified = await fetch(`http://127.0.0.1:${port}/api/v3/meta`);

  assert.equal(described.status, 200);
  assert.deepEqual(((await described.json()) as { routes: unknown[] }).routes, [
    { route: 'GET /api/v3/meta', action: 'handle', summary: 'Meta', allowedBy: [], allowAll: true },
  ]);
  assert.equal(unidentified.status, 401);
  assert.equal(unidentified.headers.get('opsiforce-outcome'), 'unidentified');
});

test('dev writes the sdk 2 types and serves the service', async (t) => {
  const folder = sdk2Folder();
  const running = startCli(['dev', folder, '--port', '0'], { SERVICE_GATEWAY_API_KEY: gatewayKey });
  t.after(() => running.stop());
  const [, port] = await running.waitFor(/listening on port (\d+) \(SDK 2/);

  const answer = await fetch(`http://127.0.0.1:${port}/api/v3/meta`);

  assert.equal(answer.status, 401);
  assert.match(readFileSync(join(folder, 'service.types.ts'), 'utf8'), /export type Setting = /);
});

test('serve refuses an sdk 2 folder whose service.ts has no defined service', () => {
  const folder = serviceFolderWith({
    'service.json': JSON.stringify(githubManifest()),
    'service.ts': 'export default {};\n',
  });

  const run = runCli(['serve', folder, '--port', '0'], { SERVICE_GATEWAY_API_KEY: gatewayKey });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /service\.ts has no default export; write export default defineService/);
});
