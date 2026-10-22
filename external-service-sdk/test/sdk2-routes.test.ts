import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowAll, defineService, route, type RouteCheck, type Verdict } from '@opsiforce/external-service-sdk';
import { testService } from '@opsiforce/external-service-sdk/testing';

import { sdkPackageVersion } from '../src/package-version.ts';

import {
  definedWith,
  githubManifest,
  projectConfiguration,
  recordedUpstream,
  refusalSeen,
  rest,
  serviceConfiguration,
} from './support/sdk2.ts';

const handled = (name: string) => () => Response.json({ route: name });

function kitFor(routes: Parameters<typeof definedWith>[0], upstreams = {}) {
  return testService(definedWith(routes), { serviceConfiguration, projectConfiguration, upstreams });
}

async function routeName(answer: Response): Promise<string | null> {
  return answer.status === 200 ? ((await answer.json()) as { route: string }).route : null;
}

test('routes are matched top to bottom and the first match wins', async () => {
  const kit = kitFor([
    route('GET /api/v3/repos/acme/web', {
      summary: 'One repository',
      allowedBy: [],
      check: allowAll,
      handle: handled('first'),
    }),
    route('GET /api/v3/repos/:owner/:repo', {
      summary: 'Any repository',
      allowedBy: [],
      check: allowAll,
      handle: handled('second'),
    }),
  ]);

  assert.equal(await routeName(await kit.fetch('/api/v3/repos/acme/web')), 'first');
  assert.equal(await routeName(await kit.fetch('/api/v3/repos/acme/api')), 'second');
});

test('a request no route matches is refused as not supported', async () => {
  const kit = kitFor([
    route('GET /api/v3/meta', { summary: 'Meta', allowedBy: [], check: allowAll, handle: handled('meta') }),
  ]);

  const seen = await refusalSeen(await kit.fetch('/api/v3/user', { method: 'POST' }));

  assert.equal(seen.status, 404);
  assert.equal(seen.outcome, 'not supported');
  assert.equal(seen.body.outcome, 'not supported');
  assert.equal(seen.body.message, 'POST /api/v3/user is not supported by this service.');
});

test('a pattern names its methods with | or takes any method with *', async () => {
  const kit = kitFor([
    route('GET|HEAD /issues', { summary: 'Read issues', allowedBy: [], check: allowAll, handle: handled('read') }),
    route('* /anything', { summary: 'Anything', allowedBy: [], check: allowAll, handle: handled('any') }),
  ]);

  assert.equal((await kit.fetch('/issues', { method: 'HEAD' })).status, 200);
  assert.equal((await kit.fetch('/issues', { method: 'DELETE' })).status, 404);
  assert.equal(await routeName(await kit.fetch('/anything', { method: 'PATCH' })), 'any');
});

test(':name matches one whole non-empty segment and ** zero or more trailing segments', async () => {
  const kit = kitFor([
    route('GET /repos/:owner/:repo', {
      summary: 'Repository',
      allowedBy: [],
      check: allowAll,
      handle: (_request, ctx) => Response.json({ route: `${ctx.params.owner}|${ctx.params.repo}` }),
    }),
    route('GET /git/**', { summary: 'Git', allowedBy: [], check: allowAll, handle: handled('git') }),
  ]);

  assert.equal(await routeName(await kit.fetch('/repos/acme/web')), 'acme|web');
  assert.equal(await routeName(await kit.fetch('/repos/acme/web%20site')), 'acme|web site');
  assert.equal((await kit.fetch('/repos/acme/web/issues')).status, 404);
  assert.equal((await kit.fetch('/repos/acme')).status, 404);
  assert.equal((await kit.fetch('/repos/acme/')).status, 404);
  assert.equal(await routeName(await kit.fetch('/git')), 'git');
  assert.equal(await routeName(await kit.fetch('/git/acme/web/info/refs')), 'git');
});

test('matching is case-sensitive on the full path and never looks at the query', async () => {
  const kit = kitFor([
    route('GET /api/v3/meta', { summary: 'Meta', allowedBy: [], check: allowAll, handle: handled('meta') }),
  ]);

  assert.equal((await kit.fetch('/API/v3/meta')).status, 404);
  assert.equal((await kit.fetch('/meta')).status, 404);
  assert.equal(await routeName(await kit.fetch('/api/v3/meta?x=/api/v3/other')), 'meta');
});

test('a route with neither to nor handle refuses with its summary', async () => {
  const kit = kitFor([
    route('* /api/v3/repos/:owner/:repo/actions/**', {
      summary: 'Workflows are not available through this service',
      allowedBy: [],
    }),
    route('* /api/v3/**', { summary: 'Everything else', allowedBy: [], check: allowAll, handle: handled('rest') }),
  ]);

  const seen = await refusalSeen(await kit.fetch('/api/v3/repos/acme/web/actions/runs'));

  assert.equal(seen.status, 404);
  assert.equal(seen.outcome, 'not supported');
  assert.equal(seen.body.message, 'Workflows are not available through this service.');
});

test('a pattern with text around :name, ** before the end or no method is refused at definition', () => {
  assert.throws(
    () => route('GET /:owner/:repo.git', { summary: 'Git', allowedBy: [], check: allowAll }),
    /whole segment/
  );
  assert.throws(() => route('GET /**/refs', { summary: 'Git', allowedBy: [], check: allowAll }), /last segment/);
  assert.throws(() => route('/repos', { summary: 'Repos', allowedBy: [], check: allowAll }), /METHOD/);
  assert.throws(() => route('GET /repos', { summary: 'Repos', allowedBy: [], to: rest }), /needs a check/);
});

test('every route names the settings that govern it, an empty list when none does', () => {
  const missing = { summary: 'Repos', check: allowAll } as unknown as Parameters<typeof route>[1];
  assert.throws(() => route('GET /repos', missing), /allowedBy lists the Project-form settings/);
  assert.throws(
    () => route('* /actions/**', { summary: 'No workflows' } as unknown as Parameters<typeof route>[1]),
    /allowedBy/
  );
  assert.throws(
    () =>
      route('GET /repos', { summary: 'Repos', allowedBy: [7], check: allowAll } as unknown as Parameters<
        typeof route
      >[1]),
    /allowedBy/
  );
  assert.deepEqual(route('GET /meta', { summary: 'Meta', allowedBy: [], check: allowAll }).allowedBy, []);
});

for (const [name, check] of [
  ['returns undefined', () => undefined],
  ['returns true', () => true],
  [
    'throws',
    () => {
      throw new Error('boom');
    },
  ],
  ['returns a look-alike verdict', () => ({ verdict: 'allow' })],
] as [string, () => unknown][]) {
  test(`a check that ${name} fails the request and nothing is forwarded`, async () => {
    const github = recordedUpstream();
    const kit = kitFor(
      [
        route('GET /api/v3/repos/:owner/:repo', {
          summary: 'Repository',
          allowedBy: [],
          to: rest,
          check: check as unknown as RouteCheck,
        }),
      ],
      { rest: github.fake }
    );

    const seen = await refusalSeen(await kit.fetch('/api/v3/repos/acme/web'));

    assert.equal(seen.status, 502);
    assert.equal(seen.outcome, 'failed');
    assert.deepEqual(github.requests, []);
  });
}

for (const path of [
  '/api/v3/repos/acme/web/../other',
  '/api/v3/repos/acme/./web',
  '/api/v3/repos/acme/%2e%2e/web',
  '/api/v3/repos/acme/.%2E/web',
  '/api/v3//repos/acme/web',
  '/api/v3/repos/acme%2Fother/web',
  '/api/v3/repos/acme%5cother/web',
  '/api/v3/repos/acme%5Cother/web',
]) {
  test(`${path} is refused as not supported before any route`, async () => {
    const github = recordedUpstream();
    const kit = kitFor([route('* /api/v3/**', { summary: 'Everything', allowedBy: [], to: rest, check: allowAll })], {
      rest: github.fake,
    });

    const seen = await refusalSeen(await kit.fetch(path));

    assert.equal(seen.status, 404);
    assert.equal(seen.outcome, 'not supported');
    assert.deepEqual(github.requests, []);
  });
}

test('a check refusing with notSupported or notAllowed names what it refused', async () => {
  const kit = kitFor([
    route('POST /api/v3/repos/:owner/:repo/issues', {
      summary: 'Open an issue',
      allowedBy: ['repositories'],
      to: rest,
      check: (_request, ctx): Verdict =>
        ctx.params.repo === 'secret'
          ? ctx.notSupported('Issues on secret are not offered')
          : ctx.notAllowed({ message: 'Issues are closed' }),
    }),
  ]);

  const unsupported = await refusalSeen(await kit.fetch('/api/v3/repos/acme/secret/issues', { method: 'POST' }));
  const refused = await refusalSeen(await kit.fetch('/api/v3/repos/acme/web/issues', { method: 'POST' }));

  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.body.message, 'Issues on secret are not offered.');
  assert.equal(refused.status, 403);
  assert.equal(refused.outcome, 'not allowed');
  assert.equal(refused.setting, null);
  assert.deepEqual(refused.body, { outcome: 'not allowed', message: 'Issues are closed.', setting: null, link: null });
});

test('a ProjectEnvironment without a Project configuration is refused as not connected before any route', async () => {
  const kit = testService(
    definedWith([route('* /**', { summary: 'Everything', allowedBy: [], check: allowAll, handle: handled('all') })]),
    { serviceConfiguration }
  );

  const seen = await refusalSeen(await kit.fetch('/anything'));

  assert.equal(seen.status, 403);
  assert.equal(seen.outcome, 'not connected');
  assert.equal(seen.body.link, 'https://opsiforce.test/projects/project_test?configure=service');
  assert.match(seen.body.message, /^This Project is not connected to GitHub\./);
});

test('a Project configuration missing a required field is refused as incomplete naming the field', async () => {
  const manifest = githubManifest();
  manifest.projectForm[1].required = true;
  const kit = testService(
    defineService({
      manifest,
      routes: [route('* /**', { summary: 'All', allowedBy: [], check: allowAll, handle: handled('all') })],
    }),
    { serviceConfiguration, projectConfiguration }
  );

  const seen = await refusalSeen(await kit.fetch('/anything'));

  assert.equal(seen.status, 403);
  assert.equal(seen.outcome, 'incomplete');
  assert.equal(seen.setting, 'coAuthor');
  assert.equal(seen.body.link, 'https://opsiforce.test/projects/project_test?configure=service&field=coAuthor');
  assert.match(seen.body.message, /missing "Co-author trailer"/);
});

test('a Service configuration missing a required field refuses nothing and route code sees the missing keys', async () => {
  let seen: readonly string[] | undefined;
  const kit = testService(
    definedWith([
      route('* /**', {
        summary: 'All',
        allowedBy: [],
        check: allowAll,
        handle: (_request, ctx) => {
          seen = ctx.missingServiceFields;
          return Response.json({ route: 'all' });
        },
      }),
    ]),
    { serviceConfiguration: { privateKey: serviceConfiguration.privateKey }, projectConfiguration }
  );

  const answer = await kit.fetch('/anything');

  assert.equal(answer.status, 200);
  assert.deepEqual(seen, ['appId']);
});

test('a request reaching an upstream without a fake fails', async () => {
  const kit = kitFor([route('GET /api/v3/user', { summary: 'Who am I', allowedBy: [], to: rest, check: allowAll })]);

  const seen = await refusalSeen(await kit.fetch('/api/v3/user'));

  assert.equal(seen.status, 502);
  assert.equal(seen.outcome, 'failed');
});

test('a forwarded request keeps the caller User-Agent and gets the SDK one when it has none', async () => {
  const github = recordedUpstream();
  const kit = kitFor([route('GET /api/v3/**', { summary: 'Reads', allowedBy: [], to: rest, check: allowAll })], {
    rest: github.fake,
  });

  await kit.fetch('/api/v3/user', { headers: { 'user-agent': 'gh/2.60.0' } });
  await kit.fetch('/api/v3/user');

  assert.deepEqual(
    github.requests.map((request) => request.headers.get('user-agent')),
    ['gh/2.60.0', `opsiforce-external-service-sdk/${sdkPackageVersion}`]
  );
});
