import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AnyServiceHandlers } from '@opsiforce/external-service-sdk/server';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { testService } from '@opsiforce/external-service-sdk/testing';

import type { JsonObject } from './support/fixtures.ts';

function mailboxManifest(): JsonObject {
  return {
    sdk: 1,
    displayName: 'Mailboxes',
    description: 'Reads one picked mailbox.',
    serviceForm: [
      { key: 'apiKey', type: 'secret', label: 'API key' },
      {
        key: 'mailboxes',
        type: 'list',
        label: 'Mailboxes',
        item: [
          { key: 'label', type: 'text', label: 'Label', required: true },
          { key: 'token', type: 'secret', label: 'Token', required: true },
        ],
      },
    ],
    projectForm: [
      {
        key: 'mailbox',
        type: 'select',
        label: 'Mailbox',
        options: { serviceConfiguration: 'mailboxes', labelKey: 'label' },
      },
      { key: 'summary', type: 'info', label: 'Summary', call: 'summary' },
    ],
    operations: {
      mailboxes: { kind: 'read', description: 'List the mailboxes the call receives.', input: { type: 'object' } },
      leak: { kind: 'read', description: 'Answer with the API key.', input: { type: 'object' } },
    },
  };
}

const serviceConfiguration = {
  apiKey: 'api-key-0123456789',
  mailboxes: [
    { id: 'mb_support', label: 'Support', token: 'support-token-0123' },
    { id: 'mb_sales', label: 'Sales', token: 'sales-token-0123' },
  ],
};

type SeenContext = { serviceConfiguration: { apiKey?: { reveal(): string }; mailboxes?: { id: string }[] } };

function mailboxService(projectConfiguration: JsonObject = {}) {
  const manifest = mailboxManifest();
  const handlers: AnyServiceHandlers = {
    manifestHash: computeManifestHash(manifest),
    operations: {
      mailboxes: (_input: unknown, ctx: SeenContext) => ({
        ids: (ctx.serviceConfiguration.mailboxes ?? []).map((mailbox) => mailbox.id),
      }),
      leak: (_input: unknown, ctx: SeenContext) => ({ key: ctx.serviceConfiguration.apiKey?.reveal() }),
    },
    info: {
      summary: (_request: unknown, ctx: SeenContext) => ({
        text: (ctx.serviceConfiguration.mailboxes ?? []).map((mailbox) => mailbox.id).join(','),
      }),
    },
  };
  return testService(manifest, handlers, { serviceConfiguration, projectConfiguration });
}

test('an Operation receives only the Service configuration list items its Project configuration picks, as from the Gate', async () => {
  const service = mailboxService({ mailbox: 'mb_sales', operations: { mailboxes: true } });

  const answer = await service.call<{ ids: string[] }>('mailboxes');

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.ids, ['mb_sales']);
});

test('a Project form call receives only the list items its unsaved values pick', async () => {
  const answer = await mailboxService().info<{ text: string }>('summary', { values: { mailbox: 'mb_support' } });

  assert.equal(answer.status, 200);
  assert.equal(answer.body.text, 'mb_support');
});

test('an answer that echoes a secret the call carried is withheld with secret-in-response, as by the Gate', async () => {
  const service = mailboxService({ operations: { leak: true } });

  const answer = await service.call('leak');

  assert.equal(answer.status, 502);
  assert.equal(answer.problem?.type, 'urn:opsiforce:error:secret-in-response');
  assert.equal(JSON.stringify(answer.body).includes('api-key-0123456789'), false);
});
