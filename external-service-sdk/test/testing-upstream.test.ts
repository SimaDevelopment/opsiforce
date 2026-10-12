import assert from 'node:assert/strict';
import { test } from 'node:test';

import { upstreamUnauthorized, type Secret } from '@opsiforce/external-service-sdk';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { testService } from '@opsiforce/external-service-sdk/testing';

const manifest = {
  sdk: 1,
  displayName: 'Cards',
  description: 'Reads and writes cards upstream.',
  serviceForm: [{ key: 'apiKey', type: 'secret' }],
  operations: {
    get_card: {
      kind: 'read',
      description: 'Get a card.',
      input: { type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'] },
    },
    create_card: {
      kind: 'write',
      description: 'Create a card.',
      input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    swallow_errors: { kind: 'read', description: 'Calls upstream and ignores failures.', input: { type: 'object' } },
  },
};

interface CardsContext {
  serviceConfiguration: { apiKey: Secret };
}

const handlers = {
  manifestHash: computeManifestHash(manifest),
  operations: {
    get_card: async (input: { cardId: string }, ctx: CardsContext) => {
      const response = await fetch(
        `https://api.trello.com/1/cards/${input.cardId}?key=${ctx.serviceConfiguration.apiKey.reveal()}`
      );
      if (response.status === 401) throw upstreamUnauthorized();
      return response.json();
    },
    create_card: async (input: { name: string }) => {
      const response = await fetch('https://api.trello.com/1/cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: input.name, idList: 'l1' }),
      });
      return response.json();
    },
    swallow_errors: async () => {
      try {
        await fetch('https://api.trello.com/1/members/me');
      } catch {
        return { ok: false };
      }
      return { ok: true };
    },
  },
};

function cards() {
  return testService(manifest, handlers, {
    serviceConfiguration: { apiKey: 'key_123' },
    projectConfiguration: { operations: { get_card: true, create_card: true, swallow_errors: true } },
  });
}

test('upstream.reply answers the handler fetch and records what was sent', async () => {
  const service = cards();
  service.upstream.reply('GET https://api.trello.com/1/cards/C9', { id: 'C9', name: 'Ship it' });

  const response = await service.call('get_card', { cardId: 'C9' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: 'C9', name: 'Ship it' });
  assert.deepEqual(
    service.upstream.requests.map((request) => `${request.method} ${request.url}`),
    ['GET https://api.trello.com/1/cards/C9?key=key_123']
  );
});

test('a reply route with a query only matches requests carrying those parameters', async () => {
  const service = cards();
  service.upstream.reply('GET https://api.trello.com/1/cards/C9?key=other', { id: 'C9' });

  await assert.rejects(service.call('get_card', { cardId: 'C9' }), /unexpected|no upstream\.reply/);
});

test('upstream.reply takes a status, so the handler meets the upstream error', async () => {
  const service = cards();
  service.upstream.reply('GET https://api.trello.com/1/cards/C9', { message: 'invalid token' }, { status: 401 });

  const response = await service.call('get_card', { cardId: 'C9' });

  assert.equal(response.status, 502);
  assert.equal(response.problem?.type, 'urn:opsiforce:error:upstream-unauthorized');
});

test('upstream.reply can answer from the request it received', async () => {
  const service = cards();
  service.upstream.reply('POST https://api.trello.com/1/cards', (request) => ({
    id: 'C10',
    sent: JSON.parse(request.body),
  }));

  const response = await service.call('create_card', { name: 'New card' });

  assert.deepEqual(response.body, { id: 'C10', sent: { name: 'New card', idList: 'l1' } });
});

test('an upstream call no reply answers fails the test, even when the handler swallows the error', async () => {
  const service = cards();

  await assert.rejects(service.call('swallow_errors'), (error: Error) => {
    assert.equal(error.name, 'AssertionError');
    assert.match(error.message, /GET https:\/\/api\.trello\.com\/1\/members\/me/);
    return true;
  });
});

test('fetch is the real one again once a call is over', async () => {
  const realFetch = globalThis.fetch;
  const service = cards();
  service.upstream.reply('GET https://api.trello.com/1/cards/C9', { id: 'C9' });

  await service.call('get_card', { cardId: 'C9' });
  await assert.rejects(service.call('swallow_errors'));

  assert.equal(globalThis.fetch, realFetch);
});
