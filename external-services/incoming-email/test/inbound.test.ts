import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { testService, type TestInboundFile } from '@opsiforce/external-service-sdk/testing';

import handlers from '../handlers.ts';
import { forwardedEmail } from './fixtures/mailgun.ts';

const manifest = JSON.parse(readFileSync(new URL('../service.json', import.meta.url), 'utf8'));

const signingKey = 'mailgun-signing-key';

const serviceConfiguration = { receivingDomain: 'mail.example.com', signingKey, maxAttachmentMb: 1 };

const urlencoded = { 'content-type': 'application/x-www-form-urlencoded' };

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

function signed(fields: Record<string, string>, { key = signingKey, timestamp = nowSeconds() } = {}) {
  const token = fields.token ?? 'token-1';
  const signature = createHmac('sha256', key)
    .update(timestamp + token)
    .digest('hex');
  return { ...fields, timestamp, token, signature };
}

function inbound(fields: Record<string, string>, files: TestInboundFile[] = []) {
  return testService(manifest, handlers, { serviceConfiguration, origin: 'built_in' }).inbound({
    headers: urlencoded,
    rawBody: new URLSearchParams(fields).toString(),
    files,
  });
}

function firstEvent(res: Awaited<ReturnType<typeof inbound>>) {
  const [event] = res.body.events;
  assert.ok(event, 'the forward produced no Event');
  return event;
}

describe('incoming-email inbound', () => {
  it('turns a signed Mailgun forward into one email.received Event for the local part, attachments as files', async () => {
    const pdf = { field: 'attachment-1', filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: '%PDF-1.7' };
    const csv = { field: 'attachment-2', filename: 'lines.csv', mimeType: 'text/csv', bytes: 'sku,qty\nA,1\n' };
    const res = await testService(manifest, handlers, { serviceConfiguration, origin: 'built_in' }).inbound({
      headers: urlencoded,
      rawBody: new URLSearchParams(signed(forwardedEmail())).toString(),
      files: [pdf, csv],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 1);
    const event = firstEvent(res);
    assert.equal(event.type, 'email.received');
    assert.equal(event.key, '<invoice-42@customer.example>');
    assert.deepEqual(event.data, {
      address: 'k3p9x2mq7fd41abv',
      recipient: 'k3p9x2mq7fd41abv@mail.example.com',
      from: 'ann@customer.example',
      fromHeader: 'Ann Customer <ann@customer.example>',
      subject: 'Invoice 42',
      text: 'Please find the invoice attached.',
      bodyPlain: 'Please find the invoice attached.\n\n> earlier reply',
      bodyHtml: '<p>Please find the invoice attached.</p>',
      messageId: '<invoice-42@customer.example>',
      headers: [
        { name: 'Message-Id', value: '<invoice-42@customer.example>' },
        { name: 'X-Mailer', value: 'Example Mail' },
      ],
      attachments: [
        { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 8 },
        { filename: 'lines.csv', mimeType: 'text/csv', size: 12 },
      ],
      omittedAttachments: [],
    });
    assert.deepEqual(
      event.files?.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        bytes: new TextDecoder().decode(file.bytes),
      })),
      [
        { name: 'invoice.pdf', mimeType: 'application/pdf', bytes: '%PDF-1.7' },
        { name: 'lines.csv', mimeType: 'text/csv', bytes: 'sku,qty\nA,1\n' },
      ]
    );
  });

  it('dates the Event from the signed timestamp', async () => {
    const timestamp = nowSeconds();
    const res = await inbound(signed(forwardedEmail(), { timestamp }));

    assert.equal(firstEvent(res).occurredAt, new Date(Number(timestamp) * 1000).toISOString());
  });

  it('refuses a forward signed with another key', async () => {
    const res = await inbound(signed(forwardedEmail(), { key: 'someone-else' }));

    assert.equal(res.status, 401);
    assert.equal(res.problem?.type, 'urn:opsiforce:error:invalid-signature');
  });

  it('refuses a forward signed more than five minutes ago, so a captured one cannot be replayed', async () => {
    const res = await inbound(signed(forwardedEmail(), { timestamp: String(Math.floor(Date.now() / 1000) - 301) }));

    assert.equal(res.status, 401);
    assert.equal(res.problem?.type, 'urn:opsiforce:error:invalid-signature');
    assert.match(res.problem?.detail ?? '', /window/);
  });

  it('refuses a forward with no signature fields', async () => {
    const res = await inbound(forwardedEmail());

    assert.equal(res.status, 401);
    assert.equal(res.problem?.type, 'urn:opsiforce:error:invalid-signature');
  });

  it('leaves out attachments over the configured size and lists them as omitted', async () => {
    const big = {
      field: 'attachment-1',
      filename: 'scan.tiff',
      mimeType: 'image/tiff',
      bytes: new Uint8Array(1024 * 1024 + 1),
    };
    const small = { field: 'attachment-2', filename: 'note.txt', mimeType: 'text/plain', bytes: 'hi' };
    const res = await inbound(signed(forwardedEmail()), [big, small]);

    const event = firstEvent(res);
    assert.deepEqual(event.data.attachments, [{ filename: 'note.txt', mimeType: 'text/plain', size: 2 }]);
    assert.deepEqual(event.data.omittedAttachments, [
      { filename: 'scan.tiff', mimeType: 'image/tiff', size: 1024 * 1024 + 1 },
    ]);
    assert.deepEqual(
      event.files?.map((file) => file.name),
      ['note.txt']
    );
  });

  it('keys the Event on the Message-Id header when the field is missing, else on the signature token', async () => {
    const fromHeaders = await inbound(signed(forwardedEmail({ 'Message-Id': '' })));
    const fromToken = await inbound(
      signed(forwardedEmail({ 'Message-Id': '', 'message-headers': '[]', token: 'token-without-id' }))
    );

    assert.equal(firstEvent(fromHeaders).key, '<invoice-42@customer.example>');
    assert.equal(firstEvent(fromToken).key, 'token-without-id');
  });

  it('gives each recipient of a forward its own Event', async () => {
    const res = await inbound(
      signed(forwardedEmail({ recipient: 'aaaabbbbccccdddd@mail.example.com, eeeeffffgggghhhh@mail.example.com' }))
    );

    assert.deepEqual(
      res.body.events.map((event) => event.data.address),
      ['aaaabbbbccccdddd', 'eeeeffffgggghhhh']
    );
  });

  it('reads the whole plain body as the text when Mailgun sends no stripped text', async () => {
    const fields = forwardedEmail();
    delete fields['stripped-text'];
    const res = await inbound(signed(fields));

    assert.equal(firstEvent(res).data.text, 'Please find the invoice attached.\n\n> earlier reply');
  });

  it('keeps a missing subject and body as empty strings', async () => {
    const fields = forwardedEmail();
    delete fields.subject;
    delete fields['stripped-text'];
    delete fields['body-plain'];
    const res = await inbound(signed(fields));

    assert.equal(firstEvent(res).data.subject, '');
    assert.equal(firstEvent(res).data.text, '');
  });
});
