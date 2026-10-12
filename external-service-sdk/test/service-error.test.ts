import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rateLimited, ServiceError, upstreamUnauthorized } from '@opsiforce/external-service-sdk';

import { dispatchJson, echoManifest, runtimeFor, wireContext } from './support/runtime.ts';

function failingWith(error: unknown) {
  const lines: string[] = [];
  const runtime = runtimeFor(
    echoManifest(),
    {
      operations: {
        echo: () => {
          throw error;
        },
      },
    },
    { log: (line) => lines.push(line) }
  );
  return {
    lines,
    call: () => dispatchJson(runtime, 'operations', 'echo', { context: wireContext(), input: {} }),
  };
}

test('a ServiceError becomes an RFC 9457 problem with its status, code and detail', async () => {
  const response = await failingWith(
    new ServiceError({ status: 404, code: 'card-not-found', detail: 'No card 6523f1 on this board' })
  ).call();

  assert.equal(response.status, 404);
  assert.equal(response.headers['content-type'], 'application/problem+json');
  assert.deepEqual(response.json, {
    type: 'urn:opsiforce:error:card-not-found',
    title: 'Card not found',
    status: 404,
    code: 'card-not-found',
    detail: 'No card 6523f1 on this board',
    callId: 'call_test_1',
  });
});

for (const status of [400, 404, 409, 422, 429, 502]) {
  test(`a ServiceError keeps the allowed status ${status}`, async () => {
    const response = await failingWith(new ServiceError({ status, code: 'upstream-said-no' })).call();

    assert.equal(response.status, status);
    assert.equal(response.json.status, status);
  });
}

for (const status of [401, 403, 418, 500, 503]) {
  test(`a ServiceError with status ${status} is answered as 502`, async () => {
    const response = await failingWith(
      new ServiceError({ status, code: 'upstream-said-no', detail: 'Trello said no' })
    ).call();

    assert.equal(response.status, 502);
    assert.equal(response.json.status, 502);
    assert.equal(response.json.code, 'upstream-said-no');
    assert.equal(response.json.detail, 'Trello said no');
  });
}

test('rateLimited answers 429 with Retry-After', async () => {
  const response = await failingWith(rateLimited({ retryAfterSeconds: 7 })).call();

  assert.equal(response.status, 429);
  assert.equal(response.headers['retry-after'], '7');
  assert.equal(response.json.type, 'urn:opsiforce:error:rate-limited');
  assert.equal(response.json.retryAfterSeconds, 7);
});

test('upstreamUnauthorized answers 502 upstream-unauthorized', async () => {
  const response = await failingWith(upstreamUnauthorized('Trello refused the token')).call();

  assert.equal(response.status, 502);
  assert.equal(response.json.type, 'urn:opsiforce:error:upstream-unauthorized');
  assert.equal(response.json.detail, 'Trello refused the token');
});

test('an uncaught error becomes 502 service-failed with the callId and no stack', async () => {
  const failing = failingWith(new TypeError("Cannot read properties of undefined (reading 'id')"));

  const response = await failing.call();

  assert.equal(response.status, 502);
  assert.deepEqual(response.json, {
    type: 'urn:opsiforce:error:service-failed',
    title: 'Service failed',
    status: 502,
    code: 'service-failed',
    detail: 'The service failed while handling this call.',
    callId: 'call_test_1',
  });
  assert.doesNotMatch(JSON.stringify(response.json), /reading 'id'|at .*\.ts/);
  assert.match(failing.lines.join('\n'), /reading 'id'/);
});

test('a thrown non-error value becomes service-failed too', async () => {
  const response = await failingWith('boom').call();

  assert.equal(response.status, 502);
  assert.equal(response.json.code, 'service-failed');
});

test('a ServiceError code must be kebab-case', () => {
  assert.throws(() => new ServiceError({ status: 400, code: 'Bad Code' }), /kebab-case/);
});
