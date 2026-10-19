import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testService } from '@opsiforce/external-service-sdk/testing';

import service from './fixtures/github-sdk2/service.ts';

const serviceConfiguration = { appId: '1', privateKey: 'test-private-key' };
const withAccess = (access: string) => ({ repositories: [{ id: 'r1', repositoryId: 'acme/web', access }] });

test('merge passes with write', async () => {
  const github = testService(service, {
    serviceConfiguration,
    projectConfiguration: withAccess('write'),
    upstreams: { rest: () => Response.json({ merged: true }) },
  });

  const answer = await github.fetch('/api/v3/repos/acme/web/pulls/1/merge', { method: 'PUT' });

  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { merged: true });
});

test('merge is refused with pull request access', async () => {
  const github = testService(service, { serviceConfiguration, projectConfiguration: withAccess('pull_request') });

  const answer = await github.fetch('/api/v3/repos/acme/web/pulls/1/merge', { method: 'PUT' });

  assert.equal(answer.status, 403);
  assert.equal(answer.headers.get('opsiforce-outcome'), 'not allowed');
  assert.equal(answer.headers.get('opsiforce-setting'), 'repositories');
  const body = (await answer.json()) as Record<string, unknown>;
  assert.equal(body.outcome, 'not allowed');
  assert.equal(body.setting, 'repositories');
  assert.equal(body.link, 'https://opsiforce.test/projects/project_test?configure=service&field=repositories');
  assert.equal(
    body.message,
    'Merging a pull request needs write on acme/web in this Project\'s Repositories. Setting "Repositories": https://opsiforce.test/projects/project_test?configure=service&field=repositories'
  );
});
