import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { allowAll, route, type Secret } from '@opsiforce/external-service-sdk';
import {
  createServiceHttpServer,
  gatewayConfigurations,
  mintCallerIdentity,
  type CallerIdentity,
} from '@opsiforce/external-service-sdk/server';

import { definedWith, privateKey, projectConfiguration, refusalSeen, serviceConfiguration } from './support/sdk2.ts';

const gatewayKey = 'gw-default-pod-key-0123456789';
const settingsLink = 'https://opsiforce.example.com/projects/p-1?configure=github';

const caller: CallerIdentity = {
  kind: 'call',
  tenantId: 't-1',
  projectId: 'p-1',
  projectEnvironmentId: 'pe-1',
  environment: 'default',
};

async function listening(t: TestContext, server: Server): Promise<string> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => sockets.add(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface GatewayAsked {
  path: string;
  authorization: string | undefined;
  callerIdentity: string | undefined;
}

type GatewayAnswer = (asked: GatewayAsked) => unknown;

const connected: GatewayAnswer = (asked) =>
  asked.callerIdentity === undefined
    ? { serviceConfiguration, projectConfiguration: null, missing: { serviceForm: [], projectForm: [] } }
    : { serviceConfiguration, projectConfiguration, missing: { serviceForm: [], projectForm: [] }, settingsLink };

async function fakeGateway(t: TestContext, answer: GatewayAnswer = connected) {
  const asked: GatewayAsked[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const seen = {
      path: request.url ?? '',
      authorization: request.headers.authorization,
      callerIdentity: request.headers['x-opsiforce-caller'] as string | undefined,
    };
    asked.push(seen);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(answer(seen)));
  });
  return { asked, url: `${await listening(t, server)}/api/gateway` };
}

interface Seen {
  caller: CallerIdentity;
  projectConfiguration: unknown;
  privateKey: string;
}

async function servedPod(t: TestContext, options: { gatewayUrl?: string; now?: () => number } = {}) {
  const seen: Seen[] = [];
  const defined = definedWith([
    route('GET /**', {
      summary: 'Anything',
      allowedBy: [],
      check: allowAll,
      handle: (_request, ctx) => {
        seen.push({
          caller: ctx.caller,
          projectConfiguration: ctx.projectConfiguration,
          privateKey: (ctx.serviceConfiguration.privateKey as Secret).reveal(),
        });
        return Response.json({ ok: true });
      },
    }),
  ]);
  const stateFile = join(mkdtempSync(join(tmpdir(), 'sdk2-state-')), 'service-state.db');
  const started =
    options.now === undefined
      ? createServiceHttpServer(defined, { gatewayKey, stateFile, gatewayUrl: options.gatewayUrl ?? '' })
      : createServiceHttpServer(defined, {
          gatewayKey,
          stateFile,
          configurations: gatewayConfigurations({ url: options.gatewayUrl ?? '', gatewayKey, now: options.now }),
        });
  return { seen, service: started.service, url: await listening(t, started.server) };
}

function call(url: string, path = '/repos', as: CallerIdentity = caller) {
  return fetch(`${url}${path}`, { headers: { 'x-opsiforce-caller': mintCallerIdentity(as, gatewayKey) } });
}

test('a request reads its Project configuration from the gateway with the pod’s key and its Caller identity', async (t) => {
  const gateway = await fakeGateway(t);
  const pod = await servedPod(t, { gatewayUrl: gateway.url });
  const identity = mintCallerIdentity(caller, gatewayKey);

  const answer = await fetch(`${pod.url}/repos`, { headers: { 'x-opsiforce-caller': identity } });

  assert.equal(answer.status, 200);
  assert.deepEqual(gateway.asked, [
    { path: '/api/gateway/configuration', authorization: `Bearer ${gatewayKey}`, callerIdentity: identity },
  ]);
  assert.equal(pod.seen.length, 1);
  assert.deepEqual(pod.seen[0]?.projectConfiguration, projectConfiguration);
  assert.equal(pod.seen[0]?.privateKey, privateKey);
});

test('a configuration is kept in memory for at most five seconds', async (t) => {
  const gateway = await fakeGateway(t);
  let clock = 1_000_000;
  const pod = await servedPod(t, { gatewayUrl: gateway.url, now: () => clock });

  await call(pod.url);
  clock += 4_999;
  await call(pod.url);
  const keptFor = gateway.asked.length;
  clock += 1;
  await call(pod.url);

  assert.equal(keptFor, 1);
  assert.equal(gateway.asked.length, 2);
  assert.equal(pod.seen.length, 3);
});

test('each ProjectEnvironment’s configuration is fetched and kept on its own', async (t) => {
  const gateway = await fakeGateway(t);
  const pod = await servedPod(t, { gatewayUrl: gateway.url });

  await call(pod.url);
  await call(pod.url, '/repos', { ...caller, projectEnvironmentId: 'pe-2' });
  await call(pod.url);

  assert.equal(gateway.asked.length, 2);
});

test('a ProjectEnvironment with no configuration is refused not connected, and that answer is kept too', async (t) => {
  const gateway = await fakeGateway(t, () => ({
    serviceConfiguration,
    projectConfiguration: null,
    missing: { serviceForm: [], projectForm: [] },
    settingsLink,
  }));
  const pod = await servedPod(t, { gatewayUrl: gateway.url });

  const first = await refusalSeen(await call(pod.url));
  await call(pod.url);

  assert.equal(first.status, 403);
  assert.equal(first.outcome, 'not connected');
  assert.equal(first.body.link, settingsLink);
  assert.equal(gateway.asked.length, 1);
  assert.equal(pod.seen.length, 0);
});

test('a Project configuration missing a required field is refused incomplete with a link to that field', async (t) => {
  const gateway = await fakeGateway(t, () => ({
    serviceConfiguration,
    projectConfiguration: {},
    missing: { serviceForm: [], projectForm: ['repositories'] },
    settingsLink,
  }));
  const pod = await servedPod(t, { gatewayUrl: gateway.url });

  const refused = await refusalSeen(await call(pod.url));

  assert.equal(refused.status, 403);
  assert.equal(refused.outcome, 'incomplete');
  assert.equal(refused.setting, 'repositories');
  assert.equal(refused.body.link, `${settingsLink}&field=repositories`);
  assert.match(refused.body.message, /"Repositories"/);
});

test('a failed fetch is not kept: the next request asks again', async (t) => {
  let failing = true;
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? '');
    if (failing) {
      response.statusCode = 503;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(connected({ path: '', authorization: '', callerIdentity: 'x' })));
  });
  const gatewayUrl = `${await listening(t, server)}/api/gateway`;
  const pod = await servedPod(t, { gatewayUrl });

  const failed = await refusalSeen(await call(pod.url));
  failing = false;
  const served = await call(pod.url);

  assert.equal(failed.status, 502);
  assert.equal(failed.outcome, 'failed');
  assert.equal(served.status, 200);
  assert.equal(asked.length, 2);
});

test('the service reads its Service configuration and every connected ProjectEnvironment by itself', async (t) => {
  const entries = [{ projectId: 'p-1', projectEnvironmentId: 'pe-1', projectConfiguration }];
  const gateway = await fakeGateway(t, (asked) =>
    asked.path.endsWith('/configuration/projects') ? { projectConfigurations: entries } : connected(asked)
  );
  const pod = await servedPod(t, { gatewayUrl: gateway.url });

  const configuration = await pod.service.configuration();
  const listed = await pod.service.projectConfigurations();
  await pod.service.projectConfigurations();

  assert.equal((configuration.privateKey as Secret).reveal(), privateKey);
  assert.deepEqual(listed, entries);
  assert.deepEqual(gateway.asked, [
    { path: '/api/gateway/configuration', authorization: `Bearer ${gatewayKey}`, callerIdentity: undefined },
    { path: '/api/gateway/configuration/projects', authorization: `Bearer ${gatewayKey}`, callerIdentity: undefined },
  ]);
});

function sendHook(url: string, hook: string, as: CallerIdentity) {
  return fetch(`${url}/.well-known/opsiforce/hooks/${hook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opsiforce-caller': mintCallerIdentity(as, gatewayKey) },
    body: JSON.stringify({ previous: null, current: null }),
  });
}

test('onProjectConfigurationSaved drops that ProjectEnvironment’s kept configuration, even with no hook declared', async (t) => {
  const gateway = await fakeGateway(t);
  const pod = await servedPod(t, { gatewayUrl: gateway.url });
  await call(pod.url);
  await call(pod.url, '/repos', { ...caller, projectEnvironmentId: 'pe-2' });

  const hooked = await sendHook(pod.url, 'onProjectConfigurationSaved', { ...caller, kind: 'platform' });
  await call(pod.url);
  await call(pod.url, '/repos', { ...caller, projectEnvironmentId: 'pe-2' });

  assert.equal(hooked.status, 204);
  assert.deepEqual(
    gateway.asked.map((asked) => asked.callerIdentity !== undefined),
    [true, true, true]
  );
});

test('onServiceConfigurationSaved drops the kept Service configuration and the list of Project configurations', async (t) => {
  const entries = [{ projectId: 'p-1', projectEnvironmentId: 'pe-1', projectConfiguration }];
  const gateway = await fakeGateway(t, (asked) =>
    asked.path.endsWith('/configuration/projects') ? { projectConfigurations: entries } : connected(asked)
  );
  const pod = await servedPod(t, { gatewayUrl: gateway.url });
  await pod.service.configuration();
  await pod.service.projectConfigurations();

  const hooked = await sendHook(pod.url, 'onServiceConfigurationSaved', { kind: 'platform', tenantId: 't-1' });
  await pod.service.configuration();
  await pod.service.projectConfigurations();

  assert.equal(hooked.status, 204);
  assert.equal(gateway.asked.length, 4);
});
