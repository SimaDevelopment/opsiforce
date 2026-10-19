import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { allowAll, defineService, route, upstream } from '@opsiforce/external-service-sdk';
import { mintCallerIdentity } from '@opsiforce/external-service-sdk/server';
import { testGatewayKey, testService, testServiceCaller } from '@opsiforce/external-service-sdk/testing';

import {
  definedWith,
  githubManifest,
  privateKey,
  projectConfiguration,
  recordedUpstream,
  refusalSeen,
  rest,
  serviceConfiguration,
} from './support/sdk2.ts';

const echoRoute = route('* /**', {
  summary: 'Everything',
  allowedBy: [],
  check: allowAll,
  handle: () => new Response('ok'),
});

function kitWith(...routes: Parameters<typeof definedWith>[0]) {
  return testService(definedWith(routes), { serviceConfiguration, projectConfiguration });
}

for (const [name, identity] of [
  ['no Caller identity', ''],
  ['a malformed Caller identity', 'not-a-token'],
  [
    'a Caller identity signed with another copy’s key',
    mintCallerIdentity({ ...testServiceCaller, kind: 'call' }, 'gw-other-copy'),
  ],
  [
    'an expired Caller identity',
    mintCallerIdentity({ ...testServiceCaller, kind: 'call' }, testGatewayKey, { now: Date.now() - 10 * 60_000 }),
  ],
  [
    'a call that names no ProjectEnvironment',
    mintCallerIdentity({ kind: 'call', tenantId: 'tenant_test', projectId: 'project_test' }, testGatewayKey),
  ],
] as [string, string][]) {
  test(`a request with ${name} is refused as unidentified before any route`, async () => {
    const kit = kitWith(echoRoute);

    const seen = await refusalSeen(await kit.fetch('/anything', { headers: { 'x-opsiforce-caller': identity } }));

    assert.equal(seen.status, 401);
    assert.equal(seen.outcome, 'unidentified');
    assert.equal(seen.body.outcome, 'unidentified');
  });
}

test('refusal() replaces the body of every SDK-made answer but never its status or Opsiforce headers', async () => {
  const kit = testService(
    definedWith(
      [
        route('POST /git-receive-pack', {
          summary: 'Push',
          allowedBy: ['repositories'],
          check: (_request, ctx) => ctx.notAllowed({ setting: 'repositories', message: 'Pushing needs write' }),
          handle: () => new Response('pushed'),
        }),
      ],
      {
        refusal: (refusal) =>
          new Response(`remote: ${refusal.message}\n`, {
            status: 200,
            headers: { 'content-type': 'text/plain', 'opsiforce-outcome': 'proxied', 'opsiforce-setting': 'nothing' },
          }),
      }
    ),
    { serviceConfiguration, projectConfiguration }
  );

  const refused = await kit.fetch('/git-receive-pack', { method: 'POST' });
  const unidentified = await kit.fetch('/git-receive-pack', { method: 'POST', headers: { 'x-opsiforce-caller': '' } });

  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('content-type'), 'text/plain');
  assert.equal(refused.headers.get('opsiforce-outcome'), 'not allowed');
  assert.equal(refused.headers.get('opsiforce-setting'), 'repositories');
  assert.match(await refused.text(), /^remote: Pushing needs write\. Setting "Repositories": https:/);
  assert.equal(unidentified.status, 401);
  assert.equal(unidentified.headers.get('opsiforce-outcome'), 'unidentified');
  assert.equal(unidentified.headers.get('opsiforce-setting'), null);
});

test('refusal() answering undefined or throwing keeps the default JSON body', async () => {
  const kit = testService(definedWith([], { refusal: () => undefined }), {
    serviceConfiguration,
    projectConfiguration,
  });
  const throwing = testService(
    definedWith([], {
      refusal: () => {
        throw new Error('broken');
      },
    }),
    { serviceConfiguration, projectConfiguration }
  );

  assert.equal((await refusalSeen(await kit.fetch('/x'))).body.outcome, 'not supported');
  assert.equal((await refusalSeen(await throwing.fetch('/x'))).body.outcome, 'not supported');
});

test('a handle answer containing a secret of the Service configuration is refused as failed', async () => {
  const kit = kitWith(
    route('GET /leak', {
      summary: 'Leak',
      allowedBy: [],
      check: allowAll,
      handle: () => Response.json({ key: privateKey }),
    }),
    route('GET /leak-header', {
      summary: 'Leak in a header',
      allowedBy: [],
      check: allowAll,
      handle: () => new Response('ok', { headers: { 'x-debug': `key=${privateKey}` } }),
    })
  );

  for (const path of ['/leak', '/leak-header']) {
    const seen = await refusalSeen(await kit.fetch(path));
    assert.equal(seen.status, 502);
    assert.equal(seen.outcome, 'failed');
    assert.equal(seen.body.message, "GitHub's answer was blocked because it contained a stored secret.");
  }
});

test('a proxied answer containing a secret passes untouched', async () => {
  const kit = testService(
    definedWith([route('GET /api/v3/user', { summary: 'Me', allowedBy: [], to: rest, check: allowAll })]),
    {
      serviceConfiguration,
      projectConfiguration,
      upstreams: { rest: () => Response.json({ echoed: privateKey }) },
    }
  );

  const answer = await kit.fetch('/api/v3/user');

  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { echoed: privateKey });
});

test('the test kit never runs credentials', async () => {
  const github = recordedUpstream();
  const withCredentials = upstream({
    name: 'rest',
    api: 'GitHub REST API',
    url: 'https://api.github.com',
    mount: '/api/v3',
    credentials: () => {
      throw new Error('credentials ran');
    },
  });
  const kit = testService(
    definedWith([route('GET /api/v3/user', { summary: 'Me', allowedBy: [], to: withCredentials, check: allowAll })]),
    { serviceConfiguration, projectConfiguration, upstreams: { rest: github.fake } }
  );

  const answer = await kit.fetch('/api/v3/user', { headers: { authorization: 'Bearer caller-key' } });

  assert.equal(answer.status, 200);
  assert.equal(github.requests[0]?.url, 'https://api.github.com/user');
  assert.equal(github.requests[0]?.headers.get('authorization'), null);
});

test('GET /.well-known/opsiforce describes the upstreams, the ordered routes and the caller’s configuration', async () => {
  const kit = testService(
    definedWith([
      route('PUT /api/v3/repos/:owner/:repo/pulls/:number/merge', {
        summary: 'Merge a pull request',
        allowedBy: ['repositories'],
        to: rest,
        check: (_request, ctx) => ctx.allow(),
      }),
      route('* /api/v3/repos/:owner/:repo/actions/**', {
        summary: 'Workflows are not available through this service',
        allowedBy: [],
      }),
      route('GET /api/v3/meta', {
        summary: 'What gh asks a GitHub Enterprise host',
        allowedBy: [],
        check: allowAll,
        handle: () => Response.json({}),
      }),
    ]),
    { serviceConfiguration, projectConfiguration: { ...projectConfiguration, apiToken: 'project-secret-token' } }
  );

  const answer = await kit.fetch('/.well-known/opsiforce');
  const described = (await answer.json()) as Record<string, unknown>;

  assert.equal(answer.status, 200);
  assert.equal(described.sdk, '2.0.0');
  assert.match(described.manifestHash as string, /^[0-9a-f]{64}$/);
  assert.equal(described.settingsLink, 'https://opsiforce.test/projects/project_test?configure=service');
  assert.deepEqual(described.configuration, {
    repositories: { label: 'Repositories', value: [{ id: 'r1', repositoryId: 'acme/web', access: 'write' }] },
    apiToken: { label: 'API token', value: '[secret]' },
  });
  assert.deepEqual(described.upstreams, [
    { name: 'rest', api: 'GitHub REST API', url: 'https://api.github.com', mount: '/api/v3' },
  ]);
  assert.deepEqual(described.routes, [
    {
      route: 'PUT /api/v3/repos/:owner/:repo/pulls/:number/merge',
      action: 'proxy',
      upstream: 'rest',
      summary: 'Merge a pull request',
      allowedBy: ['repositories'],
    },
    {
      route: '* /api/v3/repos/:owner/:repo/actions/**',
      action: 'refuse',
      summary: 'Workflows are not available through this service',
      allowedBy: [],
    },
    {
      route: 'GET /api/v3/meta',
      action: 'handle',
      summary: 'What gh asks a GitHub Enterprise host',
      allowedBy: [],
      allowAll: true,
    },
  ]);
});

test('GET /.well-known/opsiforce for a platform caller with no ProjectEnvironment has no configuration', async () => {
  const kit = kitWith(echoRoute);
  const identity = mintCallerIdentity({ kind: 'platform', tenantId: 'tenant_test' }, testGatewayKey);

  const described = (await (
    await kit.fetch('/.well-known/opsiforce', { headers: { 'x-opsiforce-caller': identity } })
  ).json()) as Record<string, unknown>;

  assert.equal(described.configuration, undefined);
  assert.equal(described.settingsLink, undefined);
  assert.equal((described.routes as unknown[]).length, 1);
});

test('GET /.well-known/opsiforce shows a function url as its value for the caller', async () => {
  const perAccount = upstream({
    name: 'jira',
    api: 'Jira REST API v3',
    url: ({ serviceConfiguration: values }) => `https://${String(values.appId)}.atlassian.net`,
  });
  const kit = kitWith(route('GET /rest/**', { summary: 'Reads', allowedBy: [], to: perAccount, check: allowAll }));

  const described = (await (await kit.fetch('/.well-known/opsiforce')).json()) as { upstreams: unknown[] };

  assert.deepEqual(described.upstreams, [{ name: 'jira', api: 'Jira REST API v3', url: 'https://1.atlassian.net' }]);
});

test('the /.well-known/opsiforce subtree is never matched by a Service route', async () => {
  const kit = kitWith(echoRoute);

  for (const path of ['/.well-known/opsiforce/options/boards', '/.well-known/opsiforce/anything']) {
    const seen = await refusalSeen(await kit.fetch(path, { method: 'POST' }));
    assert.equal(seen.status, 404);
    assert.equal(seen.outcome, 'not supported');
  }
  assert.equal((await kit.fetch('/.well-known/opsiforce', { method: 'POST' })).status, 404);
  assert.equal((await kit.fetch('/.well-known/other')).status, 200);
});

test('ctx.state.update is atomic per key', async () => {
  const kit = kitWith(
    route('POST /projects', {
      summary: 'Create a project',
      allowedBy: [],
      check: allowAll,
      handle: async (_request, ctx) => {
        const created = await ctx.state.update<number>('created', async (current) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return (current ?? 0) + 1;
        });
        return Response.json({ created });
      },
    })
  );

  await Promise.all(Array.from({ length: 20 }, () => kit.fetch('/projects', { method: 'POST' })));

  assert.equal(await kit.service.state.get('created'), 20);
});

test('a check that reads the body sees it decoded, and the upstream receives it as it was sent', async () => {
  const github = recordedUpstream();
  const kit = testService(
    definedWith([
      route('POST /api/v3/graphql', {
        summary: 'GraphQL',
        allowedBy: [],
        to: rest,
        check: async (request, ctx) => {
          const { query } = (await request.json()) as { query: string };
          return query.includes('mergePullRequest') ? ctx.notAllowed({ message: 'Merging is off' }) : ctx.allow();
        },
      }),
    ]),
    { serviceConfiguration, projectConfiguration, upstreams: { rest: github.fake } }
  );
  const sent = gzipSync(JSON.stringify({ query: '{ viewer { login } }' }));

  const answer = await kit.fetch('/api/v3/graphql', {
    method: 'POST',
    headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    body: sent,
  });
  const refused = await kit.fetch('/api/v3/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: 'mutation { mergePullRequest }' }),
  });

  assert.equal(answer.status, 200);
  assert.equal(github.requests[0]?.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(new Uint8Array((await github.requests[0]?.arrayBuffer()) ?? []), new Uint8Array(sent));
  assert.equal(refused.status, 403);
  assert.equal(github.requests.length, 1);
});

test('a body over bodyLimit read by the check is refused with 413 and nothing is forwarded', async () => {
  const github = recordedUpstream();
  const kit = testService(
    definedWith([
      route('POST /api/v3/upload', {
        summary: 'Upload',
        allowedBy: [],
        to: rest,
        bodyLimit: 16,
        check: async (request, ctx) => {
          await request.text();
          return ctx.allow();
        },
      }),
    ]),
    { serviceConfiguration, projectConfiguration, upstreams: { rest: github.fake } }
  );

  const seen = await refusalSeen(await kit.fetch('/api/v3/upload', { method: 'POST', body: 'x'.repeat(17) }));

  assert.equal(seen.status, 413);
  assert.equal(seen.outcome, 'failed');
  assert.deepEqual(github.requests, []);
});

test('a body nobody reads is forwarded whatever its size', async () => {
  const github = recordedUpstream();
  const kit = testService(
    definedWith([
      route('POST /api/v3/upload', { summary: 'Upload', allowedBy: [], to: rest, bodyLimit: 16, check: allowAll }),
    ]),
    { serviceConfiguration, projectConfiguration, upstreams: { rest: github.fake } }
  );

  const answer = await kit.fetch('/api/v3/upload', { method: 'POST', body: 'x'.repeat(1000) });

  assert.equal(answer.status, 200);
  assert.equal((await github.requests[0]?.text())?.length, 1000);
});

test('through can narrow the request and filter the answer', async () => {
  const github = recordedUpstream(() =>
    Response.json([{ full_name: 'acme/web' }, { full_name: 'acme/secret' }], { headers: { 'content-length': '999' } })
  );
  const kit = testService(
    definedWith([
      route('GET /api/v3/user/repos', {
        summary: 'Your repositories, only the allowed ones',
        allowedBy: ['repositories'],
        to: rest,
        check: allowAll,
        through: async (request, _ctx, forward) => {
          const narrowed = new URL(request.url);
          narrowed.searchParams.set('per_page', '100');
          const answer = await forward(new Request(narrowed, request));
          const repositories = (await answer.json()) as { full_name: string }[];
          return Response.json(
            repositories.filter((entry) => entry.full_name === 'acme/web'),
            answer
          );
        },
      }),
    ]),
    { serviceConfiguration, projectConfiguration, upstreams: { rest: github.fake } }
  );

  const answer = await kit.fetch('/api/v3/user/repos?sort=updated');

  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-length'), null);
  assert.deepEqual(await answer.json(), [{ full_name: 'acme/web' }]);
  assert.equal(github.requests[0]?.url, 'https://api.github.com/user/repos?sort=updated&per_page=100');
});

test('ctx.count accepts only declared counters and whole numbers from 1', async () => {
  const kit = testService(
    defineService({
      manifest: githubManifest(),
      counters: { pull_requests_opened: { label: 'Pull requests opened' } },
      routes: [
        route('POST /count/:name/:n', {
          summary: 'Count',
          allowedBy: [],
          check: allowAll,
          handle: (_request, ctx) => {
            ctx.count(ctx.params.name ?? '', Number(ctx.params.n));
            return new Response('counted');
          },
        }),
      ],
    }),
    { serviceConfiguration, projectConfiguration }
  );

  assert.equal((await kit.fetch('/count/pull_requests_opened/1', { method: 'POST' })).status, 200);
  assert.equal((await kit.fetch('/count/undeclared/1', { method: 'POST' })).status, 502);
  assert.equal((await kit.fetch('/count/pull_requests_opened/0', { method: 'POST' })).status, 502);
  assert.equal((await kit.fetch('/count/pull_requests_opened/1.5', { method: 'POST' })).status, 502);
  assert.throws(
    () => defineService({ manifest: githubManifest(), routes: [], counters: { requests: { label: 'Requests' } } }),
    /built-in counter/
  );
  assert.throws(
    () => defineService({ manifest: githubManifest(), routes: [], counters: { 'Bad-Name': { label: 'Bad' } } }),
    /snake_case/
  );
});

test('service.count and the counters declaration keep to the Usage limits', () => {
  const kit = testService(
    defineService({
      manifest: githubManifest(),
      counters: { cards_created: { label: 'Cards created', description: 'Cards opened on a board' } },
      routes: [],
    }),
    { serviceConfiguration }
  );

  kit.service.count('cards_created', 1_000_000_000);
  kit.service.count('cards_created', 1, { projectEnvironment: 'pe_test' });
  assert.throws(() => kit.service.count('cards_created', 1_000_000_001), /whole numbers from 1/);
  assert.throws(() => kit.service.count('cards_created', -1), /whole numbers from 1/);
  assert.throws(() => kit.service.count('requests', 1), /declare the counter/);
  assert.throws(() => kit.service.count('toString', 1), /declare the counter/);

  const define = (counters: Record<string, { label: string; description?: string }>) => () =>
    defineService({ manifest: githubManifest(), routes: [], counters });
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`c${index}`, { label: `C${index}` }]));
  assert.doesNotThrow(define(twenty));
  assert.throws(define({ ...twenty, c20: { label: 'One too many' } }), /at most 20 counters/);
  assert.throws(define({ events: { label: 'Events' } }), /built-in counter/);
  assert.throws(define({ long: { label: 'x'.repeat(61) } }), /label is 1 to 60/);
  assert.throws(define({ ['a'.repeat(64)]: { label: 'Too long a name' } }), /snake_case/);
  assert.doesNotThrow(define({ ['a'.repeat(63)]: { label: 'Longest name' } }));
});

test('service.deliver is recorded by the test kit', async () => {
  const kit = kitWith(echoRoute);

  const results = await kit.service.deliver(
    { type: 'issue.opened', key: 'i-1', occurredAt: '2026-10-17T00:00:00Z', data: { number: 1 } },
    { to: ['pe_test'] }
  );

  assert.deepEqual(results, [{ projectEnvironmentId: 'pe_test', result: 'stored' }]);
  assert.equal(kit.deliveries.length, 1);
});
