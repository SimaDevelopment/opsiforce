import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { ServiceError, type InboundRequest, type Secret } from '@opsiforce/external-service-sdk';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { testService } from '@opsiforce/external-service-sdk/testing';

import whatsappHandlers from './fixtures/whatsapp/handlers.ts';
import { fixtureManifest } from './support/fixtures.ts';

const manifest = {
  sdk: 1,
  displayName: 'Mailbox',
  description: 'Receives signed mail.',
  inbound: true,
  serviceForm: [{ key: 'signingKey', type: 'secret' }],
  events: {
    'mail.received': {
      title: 'Mail received',
      description: 'A mail arrived.',
      data: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, region: { type: 'string' } },
        required: ['to', 'subject'],
      },
    },
  },
};

interface MailboxContext {
  serviceConfiguration: { signingKey: Secret };
}

function signed(body: string, key = 'sign_123'): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

function mailbox(inbound: (request: InboundRequest, ctx: MailboxContext) => unknown) {
  return testService(
    manifest,
    { manifestHash: computeManifestHash(manifest), inbound },
    { serviceConfiguration: { signingKey: 'sign_123' } }
  );
}

const verifyingInbound = (request: InboundRequest, ctx: MailboxContext) => {
  const expected = createHmac('sha256', ctx.serviceConfiguration.signingKey.reveal())
    .update(request.rawBody)
    .digest('hex');
  if (request.headers['x-signature'] !== expected) {
    throw new ServiceError({ status: 401, code: 'bad-signature', detail: 'The signature does not match.' });
  }
  const mail = JSON.parse(new TextDecoder().decode(request.rawBody)) as { to: string; subject: string };
  return {
    events: [
      {
        type: 'mail.received',
        key: `${mail.to}:${mail.subject}`,
        occurredAt: '2026-10-08T10:00:00Z',
        data: { ...mail, region: String(request.query.region) },
        files: request.files.map((file) => ({ name: file.filename, mimeType: file.mimeType, bytes: file.bytes })),
      },
    ],
    response: { status: 202, body: { accepted: request.files.length } },
  };
};

test('inbound drives the handler with the raw body, headers, query and files', async () => {
  const rawBody = JSON.stringify({ to: 'ops@acme.test', subject: 'Invoice' });

  const response = await mailbox(verifyingInbound).inbound({
    headers: { 'Content-Type': 'application/json', 'X-Signature': signed(rawBody) },
    query: { region: 'eu' },
    rawBody,
    files: [{ field: 'attachment', filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: '%PDF-1.7' }],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.response, { status: 202, body: { accepted: 1 } });
  const [event] = response.body.events;
  assert.equal(event?.type, 'mail.received');
  assert.deepEqual(event?.data, { to: 'ops@acme.test', subject: 'Invoice', region: 'eu' });
  assert.equal(event?.files?.[0]?.name, 'invoice.pdf');
  assert.equal(new TextDecoder().decode(event?.files?.[0]?.bytes), '%PDF-1.7');
});

test('inbound passes a ServiceError 401 back as the rejection', async () => {
  const rawBody = JSON.stringify({ to: 'ops@acme.test', subject: 'Invoice' });

  const response = await mailbox(verifyingInbound).inbound({
    headers: { 'x-signature': signed(rawBody, 'someone-else') },
    rawBody,
  });

  assert.equal(response.status, 401);
  assert.equal(response.problem?.type, 'urn:opsiforce:error:bad-signature');
});

test('inbound takes raw bytes as they arrived', async () => {
  let seen: Uint8Array | undefined;
  const bytes = new Uint8Array([0xff, 0x00, 0x7b]);

  await mailbox((request) => {
    seen = request.rawBody;
    return { events: [] };
  }).inbound({ rawBody: bytes });

  assert.deepEqual(seen, bytes);
});

test('an Event whose data does not fit service.json fails the test', async () => {
  const service = mailbox(() => ({
    events: [{ type: 'mail.received', key: 'k1', occurredAt: '2026-10-08T10:00:00Z', data: { to: 'ops@acme.test' } }],
  }));

  await assert.rejects(service.inbound({ rawBody: '{}' }), (error: Error) => {
    assert.equal(error.name, 'AssertionError');
    assert.match(error.message, /mail\.received.*subject/);
    return true;
  });
});

test('an Event type service.json does not declare fails the test', async () => {
  const service = mailbox(() => ({
    events: [{ type: 'mail.bounced', key: 'k1', occurredAt: '2026-10-08T10:00:00Z', data: {} }],
  }));

  await assert.rejects(service.inbound({ rawBody: '{}' }), /mail\.bounced/);
});

test('a built-in inbound handler is driven the same way', async () => {
  const service = testService(fixtureManifest('whatsapp'), whatsappHandlers, {
    origin: 'built_in',
    serviceConfiguration: {
      channels: [{ id: 'li_sales', channelId: 'ch_1', label: 'Sales', apiToken: 'tok_1', webhookSecret: 'whsec_1' }],
    },
  });

  const accepted = await service.inbound({ headers: { 'x-whapi-signature': 'whsec_1' }, rawBody: '{}' });
  const rejected = await service.inbound({ headers: { 'x-whapi-signature': 'forged' }, rawBody: '{}' });

  assert.equal(accepted.body.events[0]?.type, 'message.received');
  assert.equal(rejected.status, 401);
});
