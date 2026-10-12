import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALL, checkServiceManifest, type ServiceManifest } from '@opsiforce/external-service-sdk';
import {
  createBoundsChecker,
  createOperationAdmission,
  findBoundSites,
} from '@opsiforce/external-service-sdk/platform';

import { fixtureManifest, trelloManifest, type JsonObject } from './support/fixtures.ts';
import { dispatchJson, runtimeFor, wireContext } from './support/runtime.ts';

function parsed(json: JsonObject): ServiceManifest {
  const check = checkServiceManifest(json, { origin: 'custom' });
  assert.ok(check.manifest, JSON.stringify(check.problems));
  return check.manifest;
}

function scalarManifest(): JsonObject {
  return {
    sdk: 1,
    displayName: 'Tickets',
    description: 'Tickets in one queue.',
    projectForm: [
      {
        key: 'queue',
        type: 'select',
        options: [
          { value: 'support', label: 'Support queue' },
          { value: 'sales', label: 'Sales queue' },
        ],
      },
    ],
    operations: {
      open_ticket: {
        kind: 'write',
        description: 'Open a ticket.',
        input: { type: 'object', properties: { queue: { type: 'string', boundTo: 'queue' } } },
      },
    },
    bounds: { queue: { path: 'queue' } },
  };
}

test('a scalar bound allows exactly the configured value', () => {
  const bounds = createBoundsChecker({
    manifest: parsed(scalarManifest()),
    projectConfiguration: { queue: 'support' },
  });

  assert.deepEqual(bounds.values('queue'), ['support']);
  assert.equal(bounds.has('queue', 'support'), true);
  assert.equal(bounds.has('queue', 'sales'), false);
  assert.equal(bounds.has('queue', 'Support'), false);
  assert.equal(bounds.has('queue', 'support '), false);
});

test('an array bound allows any configured value and nothing else', () => {
  const bounds = createBoundsChecker({
    manifest: parsed(trelloManifest()),
    projectConfiguration: { workspace: 'li_1', boardIds: ['b1', 'b2'] },
  });

  assert.deepEqual(bounds.values('board'), ['b1', 'b2']);
  assert.equal(bounds.has('board', 'b2'), true);
  assert.equal(bounds.has('board', 'b3'), false);
  assert.equal(bounds.has('board', ['b1']), false);
});

test('empty means nothing: no value, an empty list or a missing field allow no value', () => {
  const manifest = parsed(trelloManifest());
  for (const projectConfiguration of [{}, { boardIds: [] }, { boardIds: [''] }, { boardsMode: 'selected' }]) {
    const bounds = createBoundsChecker({ manifest, projectConfiguration });
    assert.deepEqual(bounds.values('board'), []);
    assert.equal(bounds.has('board', ''), false);
    assert.equal(bounds.has('board', 'b1'), false);
  }
});

test('unless gives the ALL sentinel only when the configuration says so explicitly', () => {
  const manifest = parsed(trelloManifest());

  const all = createBoundsChecker({ manifest, projectConfiguration: { boardsMode: 'all', boardIds: [] } });
  assert.equal(all.values('board'), ALL);
  assert.equal(all.has('board', 'any-board'), true);

  const selected = createBoundsChecker({
    manifest,
    projectConfiguration: { boardsMode: 'selected', boardIds: ['b1'] },
  });
  assert.deepEqual(selected.values('board'), ['b1']);

  const unset = createBoundsChecker({ manifest, projectConfiguration: { boardIds: ['b1'] } });
  assert.deepEqual(unset.values('board'), ['b1'], 'a default of "all" never counts');

  const near = createBoundsChecker({ manifest, projectConfiguration: { boardsMode: 'ALL', boardIds: [] } });
  assert.deepEqual(near.values('board'), []);
});

const whatsappConfiguration = {
  channels: [
    { id: 'li_a', channel: 'sales', chats: ['chat_1', 'chat_2'] },
    { id: 'li_b', channel: 'support', chats: ['chat_3'] },
  ],
};

test('a list[].field bound allows the value from any item', () => {
  const bounds = createBoundsChecker({
    manifest: parsed(fixtureManifest('whatsapp')),
    projectConfiguration: whatsappConfiguration,
  });

  assert.deepEqual(bounds.values('channelItem'), ['sales', 'support']);
  assert.equal(bounds.has('channelItem', 'support'), true);
  assert.equal(bounds.has('channelItem', 'marketing'), false);
});

test('where narrows a list[].field bound to the item the input points at', () => {
  const bounds = createBoundsChecker({
    manifest: parsed(fixtureManifest('whatsapp')),
    projectConfiguration: whatsappConfiguration,
  });

  assert.deepEqual(bounds.values('chat', { channel: 'sales' }), ['chat_1', 'chat_2']);
  assert.equal(bounds.has('chat', 'chat_3', { channel: 'support' }), true);
  assert.equal(bounds.has('chat', 'chat_3', { channel: 'sales' }), false);
  assert.equal(bounds.has('chat', 'chat_1', { channel: 'marketing' }), false);
  assert.equal(bounds.has('chat', 'chat_1', {}), false);
  assert.deepEqual(bounds.values('chat'), ['chat_1', 'chat_2', 'chat_3']);
});

test('filter keeps the items whose key is allowed, and every item under ALL', () => {
  const manifest = parsed(trelloManifest());
  const cards = [
    { id: 'c1', idBoard: 'b1' },
    { id: 'c2', idBoard: 'b2' },
    { id: 'c3', idBoard: 'b3' },
  ];

  const selected = createBoundsChecker({ manifest, projectConfiguration: { boardIds: ['b1', 'b3'] } });
  assert.deepEqual(
    selected.filter('board', cards, 'idBoard').map((card) => card.id),
    ['c1', 'c3']
  );

  const all = createBoundsChecker({ manifest, projectConfiguration: { boardsMode: 'all' } });
  assert.equal(all.filter('board', cards, 'idBoard').length, 3);
});

test('assert throws for an undeclared bound name', () => {
  const bounds = createBoundsChecker({ manifest: parsed(trelloManifest()), projectConfiguration: {} });

  assert.throws(() => bounds.has('boards', 'b1'), /"boards" is not declared/);
});

test('the Gate check finds bound inputs through $ref, arrays and nested objects', () => {
  const manifest = trelloManifest();
  manifest.$defs.CreateCard.properties.labels.items.boundTo = 'board';

  assert.deepEqual(
    findBoundSites(
      parsed(manifest),
      { operation: 'create_card' },
      {
        boardId: 'b1',
        listId: 'l1',
        name: 'Card',
        labels: ['b2', 'b9'],
      }
    ),
    [
      { bound: 'board', pointer: '/boardId', value: 'b1' },
      { bound: 'board', pointer: '/labels/0', value: 'b2' },
      { bound: 'board', pointer: '/labels/1', value: 'b9' },
    ]
  );
});

test('the Gate check answers the 403 out-of-bounds problem body', () => {
  const bounds = createBoundsChecker({
    manifest: parsed(trelloManifest()),
    projectConfiguration: {
      boardIds: ['b1', 'b2'],
      _labels: { boardIds: { b1: 'Roadmap', b2: 'Bugs' } },
    },
  });

  assert.equal(bounds.check({ operation: 'create_card' }, { boardId: 'b2', listId: 'l', name: 'n' }), null);
  assert.deepEqual(bounds.check({ operation: 'create_card' }, { boardId: 'b7', listId: 'l', name: 'n' }), {
    type: 'urn:opsiforce:error:out-of-bounds',
    title: 'Out of bounds',
    status: 403,
    code: 'out-of-bounds',
    detail: 'The value at /boardId is outside the "board" bound of this Project configuration.',
    operation: 'create_card',
    bound: 'board',
    pointer: '/boardId',
    value: 'b7',
    allowed: [
      { value: 'b1', label: 'Roadmap' },
      { value: 'b2', label: 'Bugs' },
    ],
    truncated: false,
  });
});

test('touched lists the bound values an input carries, labelled as the allowed values are', () => {
  const bounds = createBoundsChecker({
    manifest: parsed(trelloManifest()),
    projectConfiguration: { boardIds: ['b1'], _labels: { boardIds: { b1: 'Roadmap' } } },
  });

  assert.deepEqual(bounds.touched({ operation: 'create_card' }, { boardId: 'b1', listId: 'l', name: 'n' }), [
    { bound: 'board', pointer: '/boardId', value: 'b1', label: 'Roadmap' },
  ]);
  assert.deepEqual(bounds.touched({ operation: 'create_card' }, { boardId: 'b7', listId: 'l', name: 'n' }), [
    { bound: 'board', pointer: '/boardId', value: 'b7', label: 'b7' },
  ]);
});

test('admission hands back the bound values it checked, admitted or out of bounds', () => {
  const admission = createOperationAdmission(parsed(trelloManifest()));
  const projectConfiguration = {
    boardIds: ['b1'],
    operations: { create_card: true },
    _labels: { boardIds: { b1: 'Roadmap' } },
  };
  const call = (boardId: string) =>
    admission.admit({ operation: 'create_card', input: { boardId, listId: 'l', name: 'n' }, projectConfiguration });

  assert.deepEqual(call('b1').touched, [{ bound: 'board', pointer: '/boardId', value: 'b1', label: 'Roadmap' }]);
  const refused = call('b7');
  assert.equal(refused.admitted, false);
  assert.deepEqual(refused.touched, [{ bound: 'board', pointer: '/boardId', value: 'b7', label: 'b7' }]);
});

test('the problem lists at most 50 allowed values and says it truncated them', () => {
  const boardIds = Array.from({ length: 60 }, (_, index) => `b${index}`);
  const bounds = createBoundsChecker({ manifest: parsed(trelloManifest()), projectConfiguration: { boardIds } });

  const outOfBounds = bounds.check({ operation: 'list_cards' }, { boardId: 'nope' });

  assert.equal(outOfBounds?.allowed.length, 50);
  assert.deepEqual(outOfBounds?.allowed[0], { value: 'b0', label: 'b0' });
  assert.equal(outOfBounds?.truncated, true);
});

test('allowed labels come from static options and from Service configuration items', () => {
  const scalar = createBoundsChecker({
    manifest: parsed(scalarManifest()),
    projectConfiguration: { queue: 'support' },
  });
  assert.deepEqual(scalar.check({ operation: 'open_ticket' }, { queue: 'sales' })?.allowed, [
    { value: 'support', label: 'Support queue' },
  ]);

  const bounds = createBoundsChecker({
    manifest: parsed(fixtureManifest('whatsapp')),
    projectConfiguration: { channels: [{ id: 'li_a', channel: 'li_sales', chats: [] }] },
    serviceConfiguration: { channels: [{ id: 'li_sales', label: 'Sales number', channelId: 'ch1' }] },
  });
  assert.deepEqual(bounds.check({ event: 'message.received' }, { channel: 'li_other', chatId: 'c' })?.allowed, [
    { value: 'li_sales', label: 'Sales number' },
  ]);
});

test('an Event is checked with where reading the Event data', () => {
  const bounds = createBoundsChecker({
    manifest: parsed(fixtureManifest('whatsapp')),
    projectConfiguration: whatsappConfiguration,
  });

  assert.equal(bounds.check({ event: 'message.received' }, { channel: 'sales', chatId: 'chat_2' }), null);
  assert.equal(bounds.check({ event: 'message.received' }, { channel: 'sales', chatId: 'chat_3' })?.pointer, '/chatId');
});

test('ctx.bounds.assert in a handler answers the same 403 out-of-bounds problem', async () => {
  const runtime = runtimeFor(scalarManifest(), {
    operations: {
      open_ticket: (_input: unknown, ctx: { bounds: { assert(name: string, value: unknown): void } }) => {
        ctx.bounds.assert('queue', 'sales');
        return { ok: true };
      },
    },
  });

  const response = await dispatchJson(runtime, 'operations', 'open_ticket', {
    context: wireContext({ projectConfiguration: { queue: 'support' } }),
    input: {},
  });

  assert.equal(response.status, 403);
  assert.equal(response.json.type, 'urn:opsiforce:error:out-of-bounds');
  assert.equal(response.json.operation, 'open_ticket');
  assert.equal(response.json.bound, 'queue');
  assert.equal(response.json.value, 'sales');
  assert.deepEqual(response.json.allowed, [{ value: 'support', label: 'Support queue' }]);
  assert.equal(response.json.callId, 'call_test_1');
});
