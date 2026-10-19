import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testService } from '@opsiforce/external-service-sdk/testing';

import service from '../service.ts';

test('refuses a request outside every group as not supported', async () => {
  const kit = testService(service, { serviceConfiguration: {}, projectConfiguration: {} });

  const answer = await kit.fetch('/anything', { method: 'POST' });

  assert.equal(answer.status, 404);
  assert.equal(answer.headers.get('opsiforce-outcome'), 'not supported');
});
