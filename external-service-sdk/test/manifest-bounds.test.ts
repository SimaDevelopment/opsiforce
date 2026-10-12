import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertAccepted, assertRefused, warningsOf } from './support/check.ts';
import { fixtureManifest, trelloManifest } from './support/fixtures.ts';

test('a bound path takes each of its four shapes', () => {
  const manifest = fixtureManifest('whatsapp');
  manifest.projectForm.push(
    { key: 'team', type: 'select', options: [{ value: 'ops', label: 'Ops' }] },
    { key: 'labels', type: 'multiselect', options: { call: 'listLabels' } }
  );
  manifest.bounds.team = { path: 'team' };
  manifest.bounds.label = { path: 'labels' };
  manifest.events['message.received'].data.properties.team = { type: 'string', boundTo: 'team' };
  manifest.events['message.received'].data.properties.labels = {
    type: 'array',
    items: { type: 'string', boundTo: 'label' },
  };

  assertAccepted(manifest, 'built_in');
});

test('an input that names an undeclared bound is refused', () => {
  const manifest = trelloManifest();
  manifest.$defs.DeleteCard.properties.cardId.boundTo = 'card';

  assertRefused(manifest, '$defs.DeleteCard.properties.cardId.boundTo', /"card" is not declared in bounds/);
});

test('an Event data property that names an undeclared bound is refused', () => {
  const manifest = trelloManifest();
  manifest.events['card.moved'].data.properties.cardId.boundTo = 'card';

  assertRefused(manifest, 'events["card.moved"].data.properties.cardId.boundTo', /"card" is not declared in bounds/);
});

test('a bound path that is not a Project form field is refused', () => {
  const manifest = trelloManifest();
  manifest.bounds.board.path = 'boards';

  assertRefused(manifest, 'bounds.board.path', /"boards" is not a Project form field/);
});

test('a bound path to a Service form field is refused', () => {
  const manifest = trelloManifest();
  manifest.bounds.board.path = 'workspaces[].label';

  assertRefused(manifest, 'bounds.board.path', /"workspaces" is not a list field of the Project form/);
});

test('a bound path to a field that holds no comparable value is refused', () => {
  const manifest = trelloManifest();
  manifest.projectForm.push({ key: 'archived', type: 'toggle' });
  manifest.bounds.board.path = 'archived';

  assertRefused(manifest, 'bounds.board.path', /"archived" is a toggle field/);
});

test('a list item bound path names a field of the list items', () => {
  const manifest = fixtureManifest('whatsapp');
  manifest.bounds.chat.path = 'channels[].groups';

  assertRefused(manifest, 'bounds.chat.path', /"channels\[\]\.groups" is not a Project form field/);
});

test('where narrows only list item paths, by a single-value item field', () => {
  const scalar = trelloManifest();
  scalar.bounds.board.where = { workspace: '/workspace' };
  assertRefused(scalar, 'bounds.board.where', /where works only with a list item path/);

  const unknownItemField = fixtureManifest('whatsapp');
  unknownItemField.bounds.chat.where = { number: '/channel' };
  assertRefused(
    unknownItemField,
    'bounds.chat.where.number',
    /"number" is not a single-value field of the "channels" items/
  );

  const notAPointer = fixtureManifest('whatsapp');
  notAPointer.bounds.chat.where = { channel: 'channel' };
  assertRefused(notAPointer, 'bounds.chat.where.channel', /JSON Pointer/);

  const twoPairs = fixtureManifest('whatsapp');
  twoPairs.bounds.chat.where = { channel: '/channel', chats: '/chatId' };
  assertRefused(twoPairs, 'bounds.chat.where', /where takes exactly one entry/);
});

test('unless names a Project form field', () => {
  const manifest = trelloManifest();
  manifest.bounds.board.unless = { mode: 'all' };

  assertRefused(manifest, 'bounds.board.unless.mode', /"mode" is not a Project form field/);
});

test('boundTo sits on a string schema', () => {
  const manifest = trelloManifest();
  manifest.$defs.ListCards.properties.limit.boundTo = 'board';

  assertRefused(manifest, '$defs.ListCards.properties.limit.boundTo', /boundTo applies only to a string schema/);
});

test('an unused bound is a warning', () => {
  const manifest = trelloManifest();
  manifest.bounds.workspace = { path: 'workspace' };

  assertAccepted(manifest);
  assert.ok(warningsOf(manifest).some((warning) => warning.path === 'bounds.workspace'));
});

test('a write or destructive Operation with no bound warns and still passes', () => {
  const manifest = trelloManifest();
  delete manifest.$defs.CreateCard.properties.boardId.boundTo;
  delete manifest.$defs.DeleteCard.properties.boardId.boundTo;

  assertAccepted(manifest);
  assert.deepEqual(
    warningsOf(manifest).map((warning) => warning.path),
    ['operations.create_card', 'operations.delete_card']
  );
});

test('a read Operation with no bound does not warn', () => {
  const manifest = trelloManifest();
  delete manifest.$defs.ListCards.properties.boardId.boundTo;

  assert.deepEqual(warningsOf(manifest), []);
});

test('an Event type with no bound is refused for a Built-in and allowed for a Custom External Service', () => {
  const manifest = fixtureManifest('incoming-email');
  delete manifest.events['email.received'].data.properties.address.boundTo;

  assertAccepted(manifest, 'custom');
  assert.throws(() => assertAccepted(manifest, 'built_in'));
});
