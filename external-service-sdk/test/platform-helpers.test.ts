import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Field, ServiceManifest } from '@opsiforce/external-service-sdk';
import {
  boundInputsOf,
  containsSentSecret,
  handlerTimeoutSeconds,
  operationLimitsOf,
  schemaInputsOf,
  serviceConfigurationSourceOf,
  trimmedToReferencedItems,
} from '@opsiforce/external-service-sdk/platform';

const encoder = new TextEncoder();

test('schemaInputsOf lists every leaf and bound input with its pointer, through $defs and alternatives', () => {
  const defs = {
    Card: { type: 'object' as const, properties: { boardId: { type: 'string' as const, boundTo: 'boards' } } },
  };
  const schema = {
    type: 'object' as const,
    properties: {
      card: { $ref: '#/$defs/Card' },
      labels: { type: 'array' as const, items: { type: 'string' as const } },
      target: { anyOf: [{ type: 'string' as const, boundTo: 'lists' }, { type: 'null' as const }] },
    },
  };

  assert.deepEqual(schemaInputsOf(schema, defs), [
    { pointer: '/card/boardId', bound: 'boards' },
    { pointer: '/labels/*', bound: null },
    { pointer: '/target', bound: 'lists' },
    { pointer: '/target', bound: null },
  ]);
  assert.deepEqual(
    boundInputsOf(schema, defs).map((input) => input.bound),
    ['boards', 'lists']
  );
});

test('schemaInputsOf stops at a $defs cycle', () => {
  const defs = { Node: { type: 'object' as const, properties: { child: { $ref: '#/$defs/Node' } } } };

  assert.deepEqual(schemaInputsOf({ $ref: '#/$defs/Node' }, defs), []);
});

test('containsSentSecret finds a sent secret in the body or a forwarded header, JSON-escaped too, ignoring short ones', () => {
  const answer = (body: string, headers: Record<string, string> = {}) => ({ body: encoder.encode(body), headers });

  assert.equal(containsSentSecret(answer('{"key":"tok-0123456789"}'), ['tok-0123456789']), true);
  assert.equal(containsSentSecret(answer(JSON.stringify({ key: 'a"b-0123456789' })), ['a"b-0123456789']), true);
  assert.equal(
    containsSentSecret(answer('{}', { 'content-disposition': 'attachment; filename=tok-0123456789' }), [
      'tok-0123456789',
    ]),
    true
  );
  assert.equal(containsSentSecret(answer('{}', { 'x-other': 'tok-0123456789' }), ['tok-0123456789']), false);
  assert.equal(containsSentSecret(answer('{"key":"short"}'), ['short']), false);
});

test('trimmedToReferencedItems keeps only the list items the Project configurations pick, lists inside lists included', () => {
  const projectForm: Field[] = [
    {
      key: 'mailbox',
      type: 'select',
      label: 'Mailbox',
      options: { serviceConfiguration: 'mailboxes', labelKey: 'label' },
    },
    {
      key: 'teams',
      type: 'list',
      label: 'Teams',
      item: [
        {
          key: 'accounts',
          type: 'multiselect',
          label: 'Accounts',
          options: { serviceConfiguration: 'accounts', labelKey: 'name' },
        },
      ],
    },
  ];
  const serviceConfiguration = {
    region: 'eu',
    mailboxes: [{ id: 'mb_1' }, { id: 'mb_2' }],
    accounts: [{ id: 'ac_1' }, { id: 'ac_2' }, { id: 'ac_3' }],
  };

  assert.deepEqual(
    trimmedToReferencedItems(
      projectForm,
      serviceConfiguration,
      { mailbox: 'mb_2' },
      { teams: [{ accounts: ['ac_1', 'ac_3'] }] }
    ),
    { region: 'eu', mailboxes: [{ id: 'mb_2' }], accounts: [{ id: 'ac_1' }, { id: 'ac_3' }] }
  );
});

test('serviceConfigurationSourceOf names the list and label key a choice field reads, and nothing for other options', () => {
  assert.deepEqual(
    serviceConfigurationSourceOf({
      key: 'mailbox',
      type: 'select',
      label: 'Mailbox',
      options: { serviceConfiguration: 'mailboxes', labelKey: 'label' },
    }),
    { serviceConfiguration: 'mailboxes', labelKey: 'label' }
  );
  assert.equal(
    serviceConfigurationSourceOf({ key: 'pick', type: 'select', label: 'Pick', options: [{ value: 'a', label: 'A' }] }),
    null
  );
  assert.equal(serviceConfigurationSourceOf({ key: 'name', type: 'text', label: 'Name' }), null);
});

test('handler time limits: an Operation its own or the default, inbound the default, form calls and hooks 10 s', () => {
  const manifest = {
    sdk: 1,
    displayName: 'Limits',
    description: 'Limits.',
    operations: {
      slow: { kind: 'read', description: 'Slow.', input: { type: 'object' }, limits: { timeoutSeconds: 120 } },
      plain: { kind: 'read', description: 'Plain.', input: { type: 'object' } },
    },
  } as unknown as ServiceManifest;

  assert.equal(handlerTimeoutSeconds(manifest, 'operations', 'slow'), 120);
  assert.equal(handlerTimeoutSeconds(manifest, 'operations', 'plain'), 30);
  assert.equal(handlerTimeoutSeconds(manifest, 'inbound'), 30);
  assert.equal(handlerTimeoutSeconds(manifest, 'options', 'anything'), 10);
  assert.equal(handlerTimeoutSeconds(manifest, 'hooks', 'onServiceConfigurationSaved'), 10);
  assert.deepEqual(operationLimitsOf(undefined), { inputBytes: 1024 * 1024, timeoutSeconds: 30 });
});
