import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testService } from '@opsiforce/external-service-sdk/testing';

import handlers from '../handlers.ts';
import manifest from '../service.json' with { type: 'json' };

test('refuses an Operation the manifest does not declare, as the Gate would', async () => {
  const service = testService(manifest, handlers);

  const answer = await service.call('not_declared', {});

  assert.equal(answer.status, 404);
  assert.equal(answer.problem?.type, 'urn:opsiforce:error:unknown-operation');
});
