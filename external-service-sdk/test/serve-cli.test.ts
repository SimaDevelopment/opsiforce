import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { computeManifestHash } from '@opsiforce/external-service-sdk/server';

import { runCli, startCli, type RunningCli } from './support/cli.ts';
import { serviceFolderWith } from './support/fixtures.ts';
import { echoManifest } from './support/runtime.ts';

const gatewayKey = 'gw-dev-pod-key-0123456789';

function handlersAnswering(version: number): string {
  return [
    "import { manifestHash } from './service.types.ts';",
    '',
    'export default {',
    '  manifestHash,',
    `  operations: { echo: (input) => ({ version: ${version}, input }) },`,
    '};',
    '',
  ].join('\n');
}

function echoFolder(): string {
  const folder = serviceFolderWith({
    'service.json': JSON.stringify(echoManifest(), null, 2),
    'handlers.ts': handlersAnswering(1),
  });
  const types = runCli(['types', folder]);
  assert.equal(types.status, 0, types.stdout + types.stderr);
  return folder;
}

function start(t: TestContext, command: 'serve' | 'dev', folder: string): RunningCli {
  const running = startCli([command, folder, '--port', '0'], { SERVICE_GATEWAY_API_KEY: gatewayKey });
  t.after(() => running.stop());
  return running;
}

async function listening(running: RunningCli): Promise<string> {
  const [, port] = await running.waitFor(/listening on port (\d+)/);
  return `http://127.0.0.1:${port}`;
}

function echo(base: string): Promise<unknown> {
  return fetch(`${base}/_service/operations/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opsiforce-gate': gatewayKey },
    body: JSON.stringify({
      context: {
        callId: 'call_1',
        caller: { tenantId: 't', projectId: 'p', environmentId: 'e', environment: 'development', via: 'agent' },
      },
      input: { text: 'hi' },
    }),
  }).then((response) => response.json());
}

async function health(base: string): Promise<{ manifestHash: string }> {
  const response = await fetch(`${base}/_service/health`, { headers: { 'x-opsiforce-gate': gatewayKey } });
  return (await response.json()) as { manifestHash: string };
}

test('serve answers the /_service wire for the folder and never reloads', async (t) => {
  const folder = echoFolder();
  const running = start(t, 'serve', folder);
  const base = await listening(running);

  assert.deepEqual(await echo(base), { version: 1, input: { text: 'hi' } });
  assert.equal((await health(base)).manifestHash, computeManifestHash(echoManifest()));

  writeFileSync(join(folder, 'handlers.ts'), handlersAnswering(2));
  await delay(600);

  assert.deepEqual(await echo(base), { version: 1, input: { text: 'hi' } });
  assert.doesNotMatch(running.output(), /restart/);
});

test('serve stops on SIGTERM', async (t) => {
  const running = start(t, 'serve', echoFolder());
  await listening(running);

  assert.equal(await running.stop(), 0);
});

test('serve refuses to start without SERVICE_GATEWAY_API_KEY', () => {
  const run = runCli(['serve', echoFolder(), '--port', '0'], { SERVICE_GATEWAY_API_KEY: '' });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /SERVICE_GATEWAY_API_KEY is not set/);
});

test('serve refuses to start on a stale service.types.ts', () => {
  const folder = echoFolder();
  writeFileSync(join(folder, 'service.json'), JSON.stringify({ ...echoManifest(), description: 'Changed.' }));

  const run = runCli(['serve', folder, '--port', '0'], { SERVICE_GATEWAY_API_KEY: gatewayKey });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /service\.types\.ts is stale/);
});

test('serve refuses an invalid service.json and prints the check', () => {
  const folder = serviceFolderWith({ 'service.json': JSON.stringify({ sdk: 1 }), 'handlers.ts': 'export default {};' });

  const run = runCli(['serve', folder, '--port', '0'], { SERVICE_GATEWAY_API_KEY: gatewayKey });

  assert.equal(run.status, 1);
  assert.match(run.stdout, /^error .*displayName/m);
});

test('dev reloads when a handler changes', async (t) => {
  const folder = echoFolder();
  const running = start(t, 'dev', folder);
  const first = await listening(running);
  assert.deepEqual(await echo(first), { version: 1, input: { text: 'hi' } });

  writeFileSync(join(folder, 'handlers.ts'), handlersAnswering(2));
  const second = await listening(running);

  assert.deepEqual(await echo(second), { version: 2, input: { text: 'hi' } });
});

test('dev rewrites service.types.ts and reloads when service.json changes', async (t) => {
  const folder = echoFolder();
  const running = start(t, 'dev', folder);
  await listening(running);
  const changed = { ...echoManifest(), description: 'Answers with what it was given, now changed.' };

  writeFileSync(join(folder, 'service.json'), JSON.stringify(changed, null, 2));
  const base = await listening(running);

  assert.equal((await health(base)).manifestHash, computeManifestHash(changed));
  assert.match(readFileSync(join(folder, 'service.types.ts'), 'utf8'), new RegExp(computeManifestHash(changed)));
});

test('dev keeps watching after a handler that cannot start, and recovers on the next change', async (t) => {
  const folder = echoFolder();
  const running = start(t, 'dev', folder);
  await listening(running);

  writeFileSync(
    join(folder, 'handlers.ts'),
    "import { manifestHash } from './service.types.ts';\nexport default { manifestHash };\n"
  );
  await running.waitFor(/missing handlers: operations\.echo/);
  writeFileSync(join(folder, 'handlers.ts'), handlersAnswering(3));
  const base = await listening(running);

  assert.deepEqual(await echo(base), { version: 3, input: { text: 'hi' } });
});
