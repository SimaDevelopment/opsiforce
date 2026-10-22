import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowAll, route, Secret, upstream } from '@opsiforce/external-service-sdk';
import { mintCallerIdentity, type CallerIdentity } from '@opsiforce/external-service-sdk/server';
import { testGatewayKey, testService, testServiceCaller } from '@opsiforce/external-service-sdk/testing';

import { definedWith, privateKey, projectConfiguration, refusalSeen, serviceConfiguration } from './support/sdk2.ts';

function revealed(value: unknown): unknown {
  if (value instanceof Secret) return { secret: value.reveal() };
  if (Array.isArray(value)) return value.map(revealed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, revealed(entry)]));
  }
  return value;
}

function post(body: unknown, init: RequestInit = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init };
}

test('a Project-form options call runs the named handler on the draft, beside the saved configurations', async () => {
  const seen: unknown[] = [];
  const kit = testService(
    definedWith([], {
      options: {
        repositories: (request, ctx) => {
          seen.push(
            revealed({
              request,
              ctx: {
                caller: ctx.caller,
                form: ctx.form,
                serviceConfiguration: ctx.serviceConfiguration,
                projectConfiguration: ctx.projectConfiguration,
              },
            })
          );
          return [{ value: 'acme/web', label: 'acme/web' }];
        },
      },
    }),
    { serviceConfiguration, projectConfiguration }
  );

  const answer = await kit.fetch(
    '/.well-known/opsiforce/options/repositories',
    post({ form: 'projectForm', values: { coAuthor: 'Ada', apiToken: 'typed-token-value' }, query: 'ac' })
  );

  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), [{ value: 'acme/web', label: 'acme/web' }]);
  assert.deepEqual(seen, [
    {
      request: {
        form: 'projectForm',
        values: { coAuthor: 'Ada', apiToken: { secret: 'typed-token-value' } },
        query: 'ac',
      },
      ctx: {
        caller: {
          kind: 'platform',
          tenantId: 'tenant_test',
          projectId: 'project_test',
          projectEnvironmentId: 'pe_test',
          environment: 'development',
        },
        form: 'projectForm',
        serviceConfiguration: { appId: '1', privateKey: { secret: privateKey } },
        projectConfiguration,
      },
    },
  ]);
});

const serviceFormCaller = { kind: 'platform', tenantId: 'tenant_test' } as const;

function asPlatform(caller: CallerIdentity = serviceFormCaller): Record<string, string> {
  return { 'content-type': 'application/json', 'x-opsiforce-caller': mintCallerIdentity(caller, testGatewayKey) };
}

test('a Service-form button sees the draft as its values and Service configuration, the saved copy stays saved', async () => {
  const seen: unknown[] = [];
  const asked: Request[] = [];
  const api = upstream({
    name: 'api',
    api: 'Pretend API',
    url: 'https://api.example.com',
    credentials: (configurations) => ({
      headers: { authorization: `Bearer ${(configurations.serviceConfiguration.privateKey as Secret).reveal()}` },
    }),
  });
  const kit = testService(
    definedWith([], {
      buttons: {
        testConnection: async (draft, ctx) => {
          const answer = await api.fetch(ctx, '/me');
          seen.push(
            revealed({
              draft,
              serviceConfiguration: ctx.serviceConfiguration,
              projectConfiguration: ctx.projectConfiguration,
              saved: await ctx.service.configuration(),
              status: answer.status,
            })
          );
          return { message: 'Connected', level: 'success' };
        },
      },
    }),
    {
      serviceConfiguration,
      projectConfiguration,
      upstreams: {
        api: (request) => {
          asked.push(request);
          return Response.json({ login: 'ada' });
        },
      },
    }
  );

  const answer = await kit.fetch('/.well-known/opsiforce/buttons/testConnection', {
    method: 'POST',
    headers: asPlatform(),
    body: JSON.stringify({ form: 'serviceForm', values: { appId: '2', privateKey: 'typed-private-key-9' } }),
  });

  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { message: 'Connected', level: 'success' });
  assert.deepEqual(seen, [
    {
      draft: { form: 'serviceForm', values: { appId: '2', privateKey: { secret: 'typed-private-key-9' } } },
      serviceConfiguration: { appId: '2', privateKey: { secret: 'typed-private-key-9' } },
      projectConfiguration: null,
      saved: { appId: '1', privateKey: { secret: privateKey } },
      status: 200,
    },
  ]);
  assert.equal(asked.length, 1);
});

test('a list item callback names the item beside the whole draft', async () => {
  const seen: unknown[] = [];
  const kit = testService(
    definedWith([], {
      info: {
        repositoryAccess: (draft) => {
          seen.push(draft);
          return { text: 'Read and write' };
        },
      },
    }),
    { serviceConfiguration, projectConfiguration }
  );

  const values = { repositories: [{ id: 'r1', repositoryId: 'acme/web' }] };
  const answer = await kit.fetch(
    '/.well-known/opsiforce/info/repositoryAccess',
    post({ form: 'projectForm', values, item: 'r1' })
  );

  assert.equal(answer.status, 200);
  assert.deepEqual(seen, [{ form: 'projectForm', values, item: 'r1' }]);
});

test('form calls answer only the platform: a call token is not supported there', async () => {
  const kit = testService(definedWith([], { options: { repositories: () => [] } }), {
    serviceConfiguration,
    projectConfiguration,
  });

  const seen = await refusalSeen(
    await kit.fetch('/.well-known/opsiforce/options/repositories', {
      method: 'POST',
      headers: asPlatform({ ...testServiceCaller, kind: 'call' }),
      body: JSON.stringify({ form: 'projectForm', values: {} }),
    })
  );

  assert.equal(seen.status, 404);
  assert.equal(seen.outcome, 'not supported');
});

test('a Project-form handler refuses a platform token that names no ProjectEnvironment', async () => {
  let ran = false;
  const kit = testService(
    definedWith([], {
      options: {
        repositories: () => {
          ran = true;
          return [];
        },
      },
    }),
    { serviceConfiguration, projectConfiguration }
  );

  const seen = await refusalSeen(
    await kit.fetch('/.well-known/opsiforce/options/repositories', {
      method: 'POST',
      headers: asPlatform(),
      body: JSON.stringify({ form: 'projectForm', values: {} }),
    })
  );

  assert.equal(seen.status, 404);
  assert.equal(seen.outcome, 'not supported');
  assert.equal(ran, false);
});

test('an unknown handler name is not supported and never reaches a Service route', async () => {
  let routed = false;
  const kit = testService(
    definedWith([
      route('* /**', {
        summary: 'Everything',
        allowedBy: [],
        check: allowAll,
        handle: () => {
          routed = true;
          return new Response('route');
        },
      }),
    ]),
    { serviceConfiguration, projectConfiguration }
  );

  const seen = await refusalSeen(
    await kit.fetch('/.well-known/opsiforce/buttons/missing', post({ form: 'projectForm', values: {} }))
  );

  assert.equal(seen.status, 404);
  assert.equal(seen.outcome, 'not supported');
  assert.equal(seen.body.message, 'This form is out of date. Reload the page and try again.');
  assert.equal(routed, false);
});

test('a handler answer holding a secret of the Service configuration is refused as failed', async () => {
  const kit = testService(
    definedWith([], {
      info: { leaky: (_draft, ctx) => ({ text: `key ${(ctx.serviceConfiguration.privateKey as Secret).reveal()}` }) },
    }),
    { serviceConfiguration, projectConfiguration }
  );

  const seen = await refusalSeen(
    await kit.fetch('/.well-known/opsiforce/info/leaky', post({ form: 'projectForm', values: {} }))
  );

  assert.equal(seen.status, 502);
  assert.equal(seen.outcome, 'failed');
  assert.match(seen.body.message, /secret/);
  assert.doesNotMatch(JSON.stringify(seen.body), new RegExp(privateKey));
});

test('a handler that throws is refused as failed', async () => {
  const kit = testService(
    definedWith([], {
      buttons: {
        broken: () => {
          throw new Error('boom');
        },
      },
    }),
    { serviceConfiguration, projectConfiguration }
  );

  const seen = await refusalSeen(
    await kit.fetch('/.well-known/opsiforce/buttons/broken', post({ form: 'projectForm', values: {} }))
  );

  assert.equal(seen.status, 502);
  assert.equal(seen.outcome, 'failed');
  assert.equal(
    seen.body.message,
    "GitHub couldn't do this. Try again; if it keeps failing, an Organization admin can check this service's Calls."
  );
});

test('every form-call answer carries the manifest hash, and another expected hash is answered 503 reloading', async () => {
  const defined = definedWith([], { info: { status: () => ({ text: 'fine' }) } });
  const kit = testService(defined, { serviceConfiguration, projectConfiguration });

  const answered = await kit.fetch('/.well-known/opsiforce/info/status', post({ form: 'projectForm', values: {} }));
  const refused = await kit.fetch('/.well-known/opsiforce/info/missing', post({ form: 'projectForm', values: {} }));
  const reloading = await kit.fetch(
    '/.well-known/opsiforce/info/status',
    post(
      { form: 'projectForm', values: {} },
      { headers: { 'content-type': 'application/json', 'x-opsiforce-expected-manifest': 'another-hash' } }
    )
  );

  assert.equal(answered.headers.get('x-opsiforce-manifest'), defined.manifestHash);
  assert.equal(refused.headers.get('x-opsiforce-manifest'), defined.manifestHash);
  assert.equal(reloading.status, 503);
  assert.equal(reloading.headers.get('x-opsiforce-manifest'), defined.manifestHash);
  assert.equal(((await reloading.json()) as { code: string }).code, 'service-reloading');
});

test('an undeclared hook is answered 204', async () => {
  const kit = testService(definedWith([]), { serviceConfiguration, projectConfiguration });

  const service = await kit.fetch('/.well-known/opsiforce/hooks/onServiceConfigurationSaved', {
    method: 'POST',
    headers: asPlatform(),
    body: JSON.stringify({ previous: null, current: serviceConfiguration }),
  });
  const project = await kit.fetch(
    '/.well-known/opsiforce/hooks/onProjectConfigurationSaved',
    post({ previous: projectConfiguration, current: null })
  );

  assert.equal(service.status, 204);
  assert.equal(project.status, 204);
});

test('a declared hook gets the change with secrets wrapped, beside the saved configurations', async () => {
  const seen: unknown[] = [];
  const kit = testService(
    definedWith([], {
      hooks: {
        onProjectConfigurationSaved: (change, ctx) => {
          seen.push(revealed({ change, form: ctx.form, caller: ctx.caller.projectEnvironmentId }));
        },
      },
    }),
    { serviceConfiguration, projectConfiguration }
  );

  const answer = await kit.fetch(
    '/.well-known/opsiforce/hooks/onProjectConfigurationSaved',
    post({ previous: { apiToken: 'old-token-value' }, current: null })
  );

  assert.equal(answer.status, 204);
  assert.deepEqual(seen, [
    {
      change: { previous: { apiToken: { secret: 'old-token-value' } }, current: null },
      form: 'projectForm',
      caller: 'pe_test',
    },
  ]);
});

test('onProjectConfigurationSaved names one ProjectEnvironment', async () => {
  const kit = testService(definedWith([]), { serviceConfiguration, projectConfiguration });

  const seen = await refusalSeen(
    await kit.fetch('/.well-known/opsiforce/hooks/onProjectConfigurationSaved', {
      method: 'POST',
      headers: asPlatform(),
      body: JSON.stringify({ previous: null, current: null }),
    })
  );

  assert.equal(seen.status, 404);
});
