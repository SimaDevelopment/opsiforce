import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ALL, Secret, type ServiceState } from '@opsiforce/external-service-sdk';
import { createFileServiceState } from '@opsiforce/external-service-sdk/server';

import { fixtureManifest, trelloManifest } from './support/fixtures.ts';
import { dispatchJson, echoManifest, runtimeFor, wireContext } from './support/runtime.ts';

type Seen = Record<string, unknown>;
type AnyContext = Record<string, unknown> & {
  bounds: { values(name: string): unknown };
  file(bytes: Uint8Array | string, options: { mimeType: string; filename?: string }): unknown;
  state: ServiceState;
  signal: AbortSignal;
};

test('an Operation handler gets its input and the whole ctx', async () => {
  let seen: Seen = {};
  const runtime = runtimeFor(trelloManifest(), {
    operations: {
      list_cards: (input: unknown, ctx: AnyContext) => {
        seen = { input, ...ctx, boardValues: ctx.bounds.values('board') };
        return { ok: true };
      },
      create_card: () => ({}),
      delete_card: () => ({}),
    },
    options: { listBoards: () => [] },
    buttons: { ping: () => ({ message: 'ok' }) },
    inbound: () => ({ events: [] }),
  });

  const response = await dispatchJson(runtime, 'operations', 'list_cards', {
    context: wireContext({
      serviceConfiguration: {
        workspaces: [{ id: 'li_1', label: 'Acme', apiKey: 'key_123', token: 'tok_456' }],
        callback: 'ignored',
      },
      projectConfiguration: {
        workspace: 'li_1',
        boardsMode: 'all',
        operations: { list_cards: true },
        receive: { 'card.moved': true },
        _labels: { workspace: { li_1: 'Acme' } },
      },
    }),
    input: { boardId: 'b1', limit: 20 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.input, { boardId: 'b1', limit: 20 });
  assert.equal(seen.operation, 'list_cards');
  assert.equal(seen.callId, 'call_test_1');
  assert.equal(seen.webhookUrl, 'https://opsiforce.example/api/external-services/webhooks/echo');
  assert.deepEqual(seen.caller, {
    tenantId: 'tenant_acme',
    projectId: 'project_1',
    environmentId: 'env_1',
    environment: 'production',
    via: 'agent',
  });
  assert.deepEqual(seen.projectConfiguration, { workspace: 'li_1', boardsMode: 'all' });
  assert.equal(seen.boardValues, ALL);
  assert.ok(seen.signal instanceof AbortSignal);

  const workspace = (seen.serviceConfiguration as { workspaces: Record<string, unknown>[] }).workspaces[0] ?? {};
  assert.ok(workspace.apiKey instanceof Secret);
  assert.equal((workspace.token as Secret).reveal(), 'tok_456');
  assert.equal(workspace.label, 'Acme');
});

test('an Operation answers JSON, or one raw file', async () => {
  const runtime = runtimeFor(
    {
      ...echoManifest(),
      operations: {
        echo: { kind: 'read', description: 'Echo.', input: { type: 'object' } },
        export: { kind: 'read', description: 'Export.', input: { type: 'object' } },
        nothing: { kind: 'read', description: 'Nothing.', input: { type: 'object' } },
      },
    },
    {
      operations: {
        echo: (input: unknown) => ({ echoed: input }),
        export: (_input: unknown, ctx: AnyContext) =>
          ctx.file('id,name\n1,Ann\n', { mimeType: 'text/csv', filename: 'cards 2026.csv' }),
        nothing: () => undefined,
      },
    }
  );

  const json = await dispatchJson(runtime, 'operations', 'echo', { context: wireContext(), input: { a: 1 } });
  assert.equal(json.status, 200);
  assert.equal(json.headers['content-type'], 'application/json');
  assert.deepEqual(json.json, { echoed: { a: 1 } });

  const file = await runtime.dispatch({ route: 'operations', name: 'export', body: { context: wireContext() } });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'text/csv');
  assert.equal(file.headers['content-disposition'], "attachment; filename*=UTF-8''cards%202026.csv");
  assert.equal(new TextDecoder().decode(file.body), 'id,name\n1,Ann\n');

  const empty = await dispatchJson(runtime, 'operations', 'nothing', { context: wireContext() });
  assert.equal(empty.json, null);
});

test('every runtime answer carries the manifest hash', async () => {
  const runtime = runtimeFor(echoManifest(), { operations: { echo: () => ({}) } });

  for (const request of [
    { route: 'operations' as const, name: 'echo', body: { context: wireContext() } },
    { route: 'operations' as const, name: 'missing', body: { context: wireContext() } },
    { route: 'operations' as const, name: 'echo', body: { nope: true } },
  ]) {
    const response = await runtime.dispatch(request);
    assert.equal(response.headers['x-opsiforce-manifest'], runtime.manifestHash);
  }
});

test('unknown handlers answer 404 and malformed bodies 400', async () => {
  const runtime = runtimeFor(echoManifest(), { operations: { echo: () => ({}) } });

  const unknown = await dispatchJson(runtime, 'operations', 'missing', { context: wireContext() });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'unknown-handler');

  const malformed = await dispatchJson(runtime, 'operations', 'echo', { context: { callId: '' } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, 'invalid-request');

  const noCaller = await dispatchJson(runtime, 'operations', 'echo', {
    context: { ...wireContext(), caller: undefined },
  });
  assert.equal(noCaller.status, 400);
});

test('a caller.via value this SDK does not know yet is served and reaches the handler as sent', async () => {
  let seenVia: unknown;
  const runtime = runtimeFor(echoManifest(), {
    operations: {
      echo: (_input: unknown, ctx: { caller: { via: string } }) => {
        seenVia = ctx.caller.via;
        return {};
      },
    },
  });
  const context = wireContext();

  const answer = await dispatchJson(runtime, 'operations', 'echo', {
    context: { ...context, caller: { ...context.caller, via: 'schedule' } },
  });

  assert.equal(answer.status, 200);
  assert.equal(seenVia, 'schedule');
});

test('options get the query and unsaved values, never more than 50 results', async () => {
  let seen: Seen = {};
  const runtime = runtimeFor(trelloManifest(), {
    operations: { list_cards: () => ({}), create_card: () => ({}), delete_card: () => ({}) },
    options: {
      listBoards: (request: Seen, ctx: Seen) => {
        seen = { request, form: ctx.form, caller: ctx.caller };
        return Array.from({ length: 70 }, (_, index) => ({ value: `b${index}`, label: `Board ${index}` }));
      },
    },
    buttons: { ping: () => ({ message: 'ok' }) },
    inbound: () => ({ events: [] }),
  });

  const response = await dispatchJson(runtime, 'options', 'listBoards', {
    context: wireContext({
      caller: { tenantId: 't', projectId: 'p', environmentId: 'e', environment: 'development', via: 'form' },
    }),
    query: 'road',
    values: { workspace: 'li_1' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.length, 50);
  assert.deepEqual(response.json[0], { value: 'b0', label: 'Board 0' });
  assert.deepEqual(seen.request, { query: 'road', values: { workspace: 'li_1' } });
  assert.equal(seen.form, 'projectForm');
});

test('a form call on a Service form item gets its secrets as Secrets', async () => {
  let token: unknown;
  const runtime = runtimeFor(
    fixtureManifest('whatsapp'),
    {
      options: { listChats: () => [] },
      info: {
        webhookStatus: (request: { values: { channels: { apiToken: unknown }[] } }) => {
          token = request.values.channels[0]?.apiToken;
          return { text: 'Webhook registered', level: 'success' };
        },
      },
      buttons: { showQr: () => ({ image: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' }, caption: 'Scan it' }) },
      inbound: () => ({ events: [] }),
    },
    { origin: 'built_in' }
  );

  const info = await dispatchJson(runtime, 'info', 'webhookStatus', {
    context: wireContext(),
    values: { channels: [{ id: 'li_1', channelId: 'c', label: 'Sales', apiToken: 'whapi_secret' }] },
  });
  assert.equal(info.status, 200);
  assert.deepEqual(info.json, { text: 'Webhook registered', level: 'success' });
  assert.ok(token instanceof Secret);

  const button = await dispatchJson(runtime, 'buttons', 'showQr', { context: wireContext(), values: {} });
  assert.deepEqual(button.json, { image: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' }, caption: 'Scan it' });
});

test('a form call that returns the wrong shape fails as service-failed', async () => {
  const runtime = runtimeFor(trelloManifest(), {
    operations: { list_cards: () => ({}), create_card: () => ({}), delete_card: () => ({}) },
    options: { listBoards: () => [{ id: 'b1' }] },
    buttons: { ping: () => ({ text: 'not a button result' }) },
    inbound: () => ({ events: [] }),
  });

  const options = await dispatchJson(runtime, 'options', 'listBoards', { context: wireContext() });
  assert.equal(options.status, 502);
  assert.equal(options.json.code, 'service-failed');
  assert.match(options.json.detail, /options\.listBoards returned/);

  const button = await dispatchJson(runtime, 'buttons', 'ping', { context: wireContext() });
  assert.equal(button.status, 502);
});

test('after-save hooks get previous and current, with receive but without the other reserved keys', async () => {
  const seen: Seen[] = [];
  const handlers = {
    operations: { list_cards: () => ({}), create_card: () => ({}), delete_card: () => ({}) },
    options: { listBoards: () => [] },
    buttons: { ping: () => ({ message: 'ok' }) },
    inbound: () => ({ events: [] }),
    hooks: {
      onProjectConfigurationSaved: (change: Seen) => {
        seen.push(change);
      },
      onServiceConfigurationSaved: (change: Seen) => {
        seen.push(change);
      },
    },
  };
  const runtime = runtimeFor(trelloManifest(), handlers);

  const project = await runtime.dispatch({
    route: 'hooks',
    name: 'onProjectConfigurationSaved',
    body: {
      context: wireContext(),
      previous: null,
      current: { workspace: 'li_1', operations: { list_cards: true }, receive: { 'card.moved': true }, _labels: {} },
    },
  });
  assert.equal(project.status, 204);
  assert.deepEqual(seen[0], { previous: null, current: { workspace: 'li_1', receive: { 'card.moved': true } } });

  await runtime.dispatch({
    route: 'hooks',
    name: 'onServiceConfigurationSaved',
    body: {
      context: wireContext(),
      previous: { workspaces: [] },
      current: { workspaces: [{ id: 'li_1', label: 'Acme', token: 'tok' }] },
    },
  });
  const current = seen[1]?.current as { workspaces: { token: unknown }[] };
  assert.ok(current.workspaces[0]?.token instanceof Secret);

  const unknown = await dispatchJson(runtime, 'hooks', 'onSomethingElse', { context: wireContext() });
  assert.equal(unknown.status, 404);
});

test('inbound gets the raw body, parsed body, headers and files, and answers Events with files in base64', async () => {
  let seen: Seen = {};
  const runtime = runtimeFor(
    fixtureManifest('incoming-email'),
    {
      inbound: (request: Seen) => {
        seen = request;
        return {
          events: [
            {
              type: 'email.received',
              key: 'msg_1',
              occurredAt: '2026-10-08T10:00:00Z',
              data: { address: 'abc', from: 'ann@example.com' },
              files: [{ name: 'a.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('hello') }],
            },
          ],
          response: { status: 200, body: { ok: true } },
        };
      },
    },
    { origin: 'built_in' }
  );
  const raw = JSON.stringify({ recipient: 'abc@in.example.com' });

  const response = await dispatchJson(runtime, 'inbound', undefined, {
    context: wireContext({ caller: undefined, projectConfiguration: undefined }),
    request: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mailgun-Signature': 'sig' },
      query: { token: 't' },
      rawBody: Buffer.from(raw).toString('base64'),
      files: [{ field: 'attachment-1', filename: 'r.pdf', mimeType: 'application/pdf', base64: 'JVBERi0=' }],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(seen.rawBody as Uint8Array), raw);
  assert.deepEqual(seen.body, { recipient: 'abc@in.example.com' });
  assert.equal((seen.headers as Seen)['x-mailgun-signature'], 'sig');
  assert.deepEqual(seen.query, { token: 't' });
  const files = seen.files as { filename: string; bytes: Uint8Array }[];
  assert.equal(files[0]?.filename, 'r.pdf');
  assert.equal(Buffer.from(files[0]?.bytes ?? []).toString('base64'), 'JVBERi0=');
  assert.deepEqual(response.json, {
    events: [
      {
        type: 'email.received',
        key: 'msg_1',
        occurredAt: '2026-10-08T10:00:00Z',
        data: { address: 'abc', from: 'ann@example.com' },
        files: [{ name: 'a.txt', mimeType: 'text/plain', base64: Buffer.from('hello').toString('base64') }],
      },
    ],
    response: { status: 200, body: { ok: true } },
  });
});

test('inbound may reject with 401, which an Operation may not', async () => {
  const { ServiceError } = await import('@opsiforce/external-service-sdk');
  const runtime = runtimeFor(
    fixtureManifest('incoming-email'),
    {
      inbound: () => {
        throw new ServiceError({ status: 401, code: 'bad-signature', detail: 'Signature mismatch' });
      },
    },
    { origin: 'built_in' }
  );

  const response = await dispatchJson(runtime, 'inbound', undefined, {
    context: wireContext(),
    request: { method: 'POST', rawBody: '' },
  });

  assert.equal(response.status, 401);
  assert.equal(response.json.code, 'bad-signature');
});

test('a handler that runs past its timeout is answered 502 timeout and its signal aborts', async () => {
  let aborted = false;
  const manifest = echoManifest();
  manifest.operations.echo.limits = { timeoutSeconds: 1 };
  const runtime = runtimeFor(manifest, {
    operations: {
      echo: (_input: unknown, ctx: AnyContext) =>
        new Promise(() => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    },
  });

  const response = await dispatchJson(runtime, 'operations', 'echo', { context: wireContext() });

  assert.equal(response.status, 502);
  assert.equal(response.json.code, 'timeout');
  assert.equal(aborted, true);
});

function stateFileIn(t: TestContext): string {
  const folder = mkdtempSync(join(tmpdir(), 'service-state-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'data', 'service-state.db');
}

function stateRuntime(file: string, handler: (ctx: AnyContext) => Promise<unknown>) {
  return runtimeFor(
    echoManifest(),
    { operations: { echo: (_input: unknown, ctx: AnyContext) => handler(ctx) } },
    { state: () => createFileServiceState(file) }
  );
}

test('ctx.state keeps JSON values by key in its SQLite file and lists them by prefix', async (t) => {
  const file = stateFileIn(t);
  let listed: unknown;
  const runtime = stateRuntime(file, async (ctx) => {
    await ctx.state.set('webhook:b1', { id: 'wh_1' });
    await ctx.state.set('webhook:b2', { id: 'wh_2' });
    await ctx.state.set('other', 1);
    await ctx.state.delete('webhook:b2');
    listed = await ctx.state.list('webhook:');
    return { got: await ctx.state.get('webhook:b1'), missing: (await ctx.state.get('nope')) ?? null };
  });

  const response = await dispatchJson(runtime, 'operations', 'echo', { context: wireContext() });

  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(response.json, { got: { id: 'wh_1' }, missing: null });
  assert.deepEqual(listed, [{ key: 'webhook:b1', value: { id: 'wh_1' } }]);
  assert.ok(existsSync(file));
});

test('ctx.state survives a restart of the runtime on the same file', async (t) => {
  const file = stateFileIn(t);
  const writer = stateRuntime(file, async (ctx) => ctx.state.set('registration', { webhookId: 'wh_9' }));
  await dispatchJson(writer, 'operations', 'echo', { context: wireContext() });

  const reader = stateRuntime(file, async (ctx) => ({ registration: await ctx.state.get('registration') }));
  const response = await dispatchJson(reader, 'operations', 'echo', { context: wireContext() });

  assert.deepEqual(response.json, { registration: { webhookId: 'wh_9' } });
});

test('ctx.state refuses an empty or over-long key and a value that is not JSON', async (t) => {
  const state = createFileServiceState(stateFileIn(t));

  await assert.rejects(state.set('', 1), /keys are 1 to 256 characters/);
  await assert.rejects(state.get('k'.repeat(257)), /keys are 1 to 256 characters/);
  await assert.rejects(state.set('k', undefined), /needs a JSON value/);
});

test('an Operation handler of a Built-in gets the platform API address and its call token as a Secret', async () => {
  let seen: Seen = {};
  const runtime = runtimeFor(echoManifest(), {
    operations: {
      echo: (_input: unknown, ctx: AnyContext) => {
        seen = { platformApi: ctx.platformApi };
        return { token: String((ctx.platformApi as { token: Secret }).token) };
      },
    },
  });

  const response = await dispatchJson(runtime, 'operations', 'echo', {
    context: wireContext({ platformApi: { url: 'http://127.0.0.1:3001', token: 'gc-call-token' } }),
    input: {},
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { token: '[secret]' });
  const access = seen.platformApi as { url: string; token: Secret };
  assert.equal(access.url, 'http://127.0.0.1:3001');
  assert.equal(access.token.reveal(), 'gc-call-token');
});

test('an Operation handler gets no platform API access when the Gate sends none', async () => {
  let seen: Seen = { platformApi: 'unset' };
  const runtime = runtimeFor(echoManifest(), {
    operations: {
      echo: (_input: unknown, ctx: AnyContext) => {
        seen = { platformApi: ctx.platformApi };
        return {};
      },
    },
  });

  await dispatchJson(runtime, 'operations', 'echo', { context: wireContext(), input: {} });

  assert.equal(seen.platformApi, undefined);
});
