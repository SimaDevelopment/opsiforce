import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';

import {
  computeManifestHash,
  createServiceServer,
  gatewayKeyMatches,
  type ServiceServerOptions,
} from '@opsiforce/external-service-sdk/server';

import sdkPackage from '../package.json' with { type: 'json' };
import trelloHandlers from './fixtures/trello/handlers.ts';
import { trelloManifest } from './support/fixtures.ts';
import { wireContext } from './support/runtime.ts';

const gatewayKey = 'gw-pod-own-key-0123456789';
const manifestHash = computeManifestHash(trelloManifest());

async function startTrello(t: TestContext, options: Partial<ServiceServerOptions> = {}) {
  const { server } = createServiceServer({
    manifest: trelloManifest(),
    handlers: trelloHandlers,
    gatewayKey,
    log: () => {},
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function post(url: string, body: unknown, key: string | null = gatewayKey): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-opsiforce-gate': key }) },
    body: JSON.stringify(body),
  });
}

test('a request without x-opsiforce-gate is answered 401 before any handler runs', async (t) => {
  const base = await startTrello(t);

  const response = await post(`${base}/_service/operations/list_cards`, { context: wireContext(), input: {} }, null);

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  assert.equal(response.headers.get('x-opsiforce-manifest'), manifestHash);
  assert.equal(((await response.json()) as { type: string }).type, 'urn:opsiforce:error:unauthorized');
});

test('a wrong, empty or prefixed key is answered 401, health included', async (t) => {
  const base = await startTrello(t);

  for (const key of ['gw-someone-else', '', gatewayKey.slice(0, -1), `${gatewayKey}x`, gatewayKey.toUpperCase()]) {
    const operation = await post(`${base}/_service/operations/list_cards`, { context: wireContext() }, key);
    assert.equal(operation.status, 401, `key ${JSON.stringify(key)}`);
  }
  const health = await fetch(`${base}/_service/health`, { headers: { 'x-opsiforce-gate': 'gw-wrong' } });
  assert.equal(health.status, 401);
});

test('the key compare is constant-time over a digest, so lengths do not short-circuit', () => {
  assert.equal(gatewayKeyMatches(gatewayKey, gatewayKey), true);
  assert.equal(gatewayKeyMatches(undefined, gatewayKey), false);
  assert.equal(gatewayKeyMatches('', gatewayKey), false);
  assert.equal(gatewayKeyMatches('x'.repeat(10_000), gatewayKey), false);
});

test('health answers the SDK version, manifest hash and handlers', async (t) => {
  const base = await startTrello(t);

  const response = await fetch(`${base}/_service/health`, { headers: { 'x-opsiforce-gate': gatewayKey } });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-opsiforce-manifest'), manifestHash);
  assert.deepEqual(await response.json(), {
    sdk: 1,
    sdkVersion: sdkPackage.version,
    manifestHash,
    handlers: {
      operations: ['create_card', 'delete_card', 'list_cards'],
      options: ['listBoards'],
      info: [],
      buttons: ['ping'],
      hooks: ['onProjectConfigurationSaved'],
      inbound: true,
    },
  });
});

test('an Operation is served with the context body and stamped with the manifest hash', async (t) => {
  const base = await startTrello(t);

  const response = await post(`${base}/_service/operations/list_cards`, {
    context: wireContext({
      serviceConfiguration: { workspaces: [{ id: 'li_1', label: 'Acme', token: 'tok_secret_1' }] },
      projectConfiguration: { workspace: 'li_1', boardIds: ['b1'] },
    }),
    input: { boardId: 'b1', limit: 5 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-opsiforce-manifest'), manifestHash);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { boardId: 'b1', limit: 5, workspace: 'Acme', token: '[secret]' });
  assert.doesNotMatch(body, /tok_secret_1/);
});

test('a call expecting another manifest is answered 503 service-reloading before any handler runs', async (t) => {
  let created = 0;
  const base = await startTrello(t, {
    handlers: {
      ...trelloHandlers,
      operations: {
        ...trelloHandlers.operations,
        create_card: (input, ctx) => {
          created++;
          return trelloHandlers.operations.create_card(input, ctx);
        },
      },
    },
  });

  const response = await fetch(`${base}/_service/operations/create_card`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opsiforce-gate': gatewayKey,
      'x-opsiforce-expected-manifest': 'sha256-of-a-newer-manifest',
    },
    body: JSON.stringify({
      context: wireContext({ projectConfiguration: { workspace: 'li_1', boardIds: ['b1'] } }),
      input: { boardId: 'b1', name: 'Printer on fire' },
    }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(response.headers.get('x-opsiforce-manifest'), manifestHash);
  assert.equal(((await response.json()) as { code: string }).code, 'service-reloading');
  assert.equal(created, 0);
});

test('a call expecting this manifest is served', async (t) => {
  const base = await startTrello(t);

  const response = await fetch(`${base}/_service/operations/list_cards`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opsiforce-gate': gatewayKey,
      'x-opsiforce-expected-manifest': manifestHash,
    },
    body: JSON.stringify({
      context: wireContext({
        serviceConfiguration: { workspaces: [{ id: 'li_1', label: 'Acme', token: 'tok_secret_1' }] },
        projectConfiguration: { workspace: 'li_1', boardIds: ['b1'] },
      }),
      input: { boardId: 'b1', limit: 5 },
    }),
  });

  assert.equal(response.status, 200);
});

test('a bound refusal inside a handler travels as 403 out-of-bounds', async (t) => {
  const base = await startTrello(t);

  const response = await post(`${base}/_service/operations/list_cards`, {
    context: wireContext({ projectConfiguration: { workspace: 'li_1', boardIds: ['b1'] } }),
    input: { boardId: 'b9', limit: 5 },
  });

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-opsiforce-manifest'), manifestHash);
  const body = (await response.json()) as { type: string; allowed: unknown };
  assert.equal(body.type, 'urn:opsiforce:error:out-of-bounds');
  assert.deepEqual(body.allowed, [{ value: 'b1', label: 'b1' }]);
});

test('form calls, hooks and inbound are served on their routes', async (t) => {
  const base = await startTrello(t);

  const options = await post(`${base}/_service/options/listBoards`, {
    context: wireContext(),
    query: 'q',
    values: { workspace: 'li_1' },
  });
  assert.deepEqual(await options.json(), [{ value: 'b1', label: 'Board for li_1 q' }]);

  const button = await post(`${base}/_service/buttons/ping`, { context: wireContext(), values: {} });
  assert.deepEqual(await button.json(), { message: 'Trello answered', level: 'success' });

  const hook = await post(`${base}/_service/hooks/onProjectConfigurationSaved`, {
    context: wireContext(),
    previous: null,
    current: { workspace: 'li_1' },
  });
  assert.equal(hook.status, 204);
  assert.equal(hook.headers.get('x-opsiforce-manifest'), manifestHash);

  const raw = JSON.stringify({ action: { data: { board: { id: 'b1' }, card: { id: 'c1' } } } });
  const inbound = await post(`${base}/_service/inbound`, {
    context: wireContext({ caller: undefined }),
    request: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(raw).toString('base64'),
    },
  });
  assert.deepEqual(await inbound.json(), {
    events: [
      { type: 'card.moved', key: 'c1', occurredAt: '2026-10-08T10:00:00Z', data: { boardId: 'b1', cardId: 'c1' } },
    ],
  });
});

test('unknown routes, wrong methods and non-JSON bodies are refused with the hash stamped', async (t) => {
  const base = await startTrello(t);

  const unknownRoute = await post(`${base}/_service/schedules/nightly`, { context: wireContext() });
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.headers.get('x-opsiforce-manifest'), manifestHash);

  const getOperation = await fetch(`${base}/_service/operations/list_cards`, {
    headers: { 'x-opsiforce-gate': gatewayKey },
  });
  assert.equal(getOperation.status, 404);

  const notJson = await fetch(`${base}/_service/operations/list_cards`, {
    method: 'POST',
    headers: { 'x-opsiforce-gate': gatewayKey },
    body: '{nope',
  });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.headers.get('x-opsiforce-manifest'), manifestHash);
});

test('the server refuses to boot without SERVICE_GATEWAY_API_KEY', () => {
  const previous = process.env.SERVICE_GATEWAY_API_KEY;
  delete process.env.SERVICE_GATEWAY_API_KEY;
  try {
    assert.throws(
      () => createServiceServer({ manifest: trelloManifest(), handlers: trelloHandlers, log: () => {} }),
      /SERVICE_GATEWAY_API_KEY is not set/
    );
  } finally {
    if (previous !== undefined) process.env.SERVICE_GATEWAY_API_KEY = previous;
  }
});

test('the server reads its key from SERVICE_GATEWAY_API_KEY', async (t) => {
  const previous = process.env.SERVICE_GATEWAY_API_KEY;
  process.env.SERVICE_GATEWAY_API_KEY = 'gw-from-env';
  t.after(() => {
    if (previous === undefined) delete process.env.SERVICE_GATEWAY_API_KEY;
    else process.env.SERVICE_GATEWAY_API_KEY = previous;
  });
  const base = await startTrello(t, { gatewayKey: undefined });

  const response = await fetch(`${base}/_service/health`, { headers: { 'x-opsiforce-gate': 'gw-from-env' } });

  assert.equal(response.status, 200);
});
