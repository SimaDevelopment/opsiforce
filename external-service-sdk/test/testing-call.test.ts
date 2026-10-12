import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testService } from '@opsiforce/external-service-sdk/testing';

import trelloHandlers from './fixtures/trello/handlers.ts';
import { trelloManifest } from './support/fixtures.ts';

const serviceConfiguration = {
  workspaces: [{ id: 'li_1', label: 'Acme', apiKey: 'key_123', token: 'tok_456' }],
};

function trello(projectConfiguration: Record<string, unknown> = {}) {
  return testService(trelloManifest(), trelloHandlers, {
    serviceConfiguration,
    projectConfiguration: { workspace: 'li_1', boardIds: ['b1', 'b2'], ...projectConfiguration },
  });
}

test('call runs the Operation handler with the input the Gate would deliver, defaults filled', async () => {
  const response = await trello().call('list_cards', { boardId: 'b1' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { boardId: 'b1', limit: 20, workspace: 'Acme', token: '[secret]' });
});

function countingTrello(projectConfiguration: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const operations = Object.fromEntries(
    Object.entries(trelloHandlers.operations).map(([name, handler]) => [
      name,
      (input: never, ctx: never) => {
        ran.push(name);
        return (handler as (input: never, ctx: never) => unknown)(input, ctx);
      },
    ])
  );
  const service = testService(
    trelloManifest(),
    { ...trelloHandlers, operations },
    {
      serviceConfiguration,
      projectConfiguration: { workspace: 'li_1', boardIds: ['b1', 'b2'], ...projectConfiguration },
    }
  );
  return { service, ran };
}

test('call refuses a switched-off Operation with operation-off before the handler runs', async () => {
  const { service, ran } = countingTrello({ operations: { list_cards: true, create_card: false } });

  const response = await service.call('create_card', { boardId: 'b1', listId: 'l1', name: 'Card' });

  assert.equal(response.status, 403);
  assert.equal(response.headers['content-type'], 'application/problem+json');
  assert.equal(response.problem?.type, 'urn:opsiforce:error:operation-off');
  assert.equal(response.problem?.operation, 'create_card');
  assert.deepEqual(ran, []);
});

test('an Operation missing from the stored switches counts as off', async () => {
  const { service } = countingTrello({ operations: { list_cards: true } });

  const response = await service.call('delete_card', { boardId: 'b1', cardId: 'c1' });

  assert.equal(response.problem?.type, 'urn:opsiforce:error:operation-off');
});

test('with no stored switches, reads are on and writes and destructive Operations are off, as in a new configuration', async () => {
  const { service } = countingTrello();

  assert.equal((await service.call('list_cards', { boardId: 'b1' })).status, 200);
  assert.equal(
    (await service.call('create_card', { boardId: 'b1', listId: 'l1', name: 'Card' })).problem?.code,
    'operation-off'
  );
  assert.equal((await service.call('delete_card', { boardId: 'b1', cardId: 'c1' })).problem?.code, 'operation-off');
});

test('call refuses an invalid input with invalid-input naming the pointer', async () => {
  const { service, ran } = countingTrello({ operations: { create_card: true } });

  const response = await service.call('create_card', { boardId: 'b1', listId: 'l1', name: '' });

  assert.equal(response.status, 400);
  assert.equal(response.problem?.type, 'urn:opsiforce:error:invalid-input');
  assert.deepEqual(response.problem?.errors, [
    { pointer: '/name', detail: 'must NOT have fewer than 1 characters', rule: 'minLength' },
  ]);
  assert.deepEqual(ran, []);
});

test('call refuses an input over the Operation limit with input-too-large before validating it', async () => {
  const { service, ran } = countingTrello({ operations: { create_card: true } });

  const response = await service.call('create_card', { boardId: 'b1', name: 'x'.repeat(1024 * 1024) });

  assert.equal(response.status, 413);
  assert.equal(response.problem?.type, 'urn:opsiforce:error:input-too-large');
  assert.equal(response.problem?.limit, 1024 * 1024);
  assert.deepEqual(ran, []);
});

test('call refuses an out-of-bounds id with the out-of-bounds body the Gate sends', async () => {
  const { service, ran } = countingTrello({ _labels: { boardIds: { b1: 'Roadmap' } } });

  const response = await service.call('list_cards', { boardId: 'b9' });

  assert.equal(response.status, 403);
  assert.equal(response.problem?.type, 'urn:opsiforce:error:out-of-bounds');
  assert.equal(response.problem?.operation, 'list_cards');
  assert.equal(response.problem?.bound, 'board');
  assert.equal(response.problem?.pointer, '/boardId');
  assert.equal(response.problem?.value, 'b9');
  assert.deepEqual(response.problem?.allowed, [
    { value: 'b1', label: 'Roadmap' },
    { value: 'b2', label: 'b2' },
  ]);
  assert.deepEqual(ran, []);
});

test('call refuses an Operation service.json does not declare with unknown-operation', async () => {
  const response = await trello().call('archive_board', {});

  assert.equal(response.status, 404);
  assert.equal(response.problem?.type, 'urn:opsiforce:error:unknown-operation');
});

test('a refusal carries the callId like every other answer', async () => {
  const service = trello();

  const allowed = await service.call('list_cards', { boardId: 'b1' });
  const refused = await service.call('list_cards', { boardId: 'b9' });

  assert.notEqual(allowed.callId, refused.callId);
  assert.equal(refused.problem?.callId, refused.callId);
});
