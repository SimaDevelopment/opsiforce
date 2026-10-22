import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { testService, type ServiceTestOptions } from '@opsiforce/external-service-sdk/testing';

import service from '../service.ts';
import { forwardedEmail } from './fixtures/mailgun.ts';

const signingKey = 'mailgun-signing-key';

const serviceConfiguration = { receivingDomain: 'mail.example.com', signingKey, maxAttachmentMb: 1 };

const webhook = '/.well-known/opsiforce/webhook';

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

const receivers = [
  { projectId: 'p-1', projectEnvironmentId: 'pe-1', projectConfiguration: { localPart: 'k3p9x2mq7fd41abv' } },
  { projectId: 'p-2', projectEnvironmentId: 'pe-2', projectConfiguration: { localPart: 'aaaabbbbccccdddd' } },
  { projectId: 'p-3', projectEnvironmentId: 'pe-3', projectConfiguration: {} },
];

interface Attachment {
  field: string;
  filename: string;
  mimeType: string;
  bytes: string | Uint8Array;
}

function signed(fields: Record<string, string>, { key = signingKey, timestamp = nowSeconds() } = {}) {
  const token = fields.token ?? 'token-1';
  const signature = createHmac('sha256', key)
    .update(timestamp + token)
    .digest('hex');
  return { ...fields, timestamp, token, signature };
}

function mailgunForward(fields: Record<string, string>, attachments: Attachment[] = []): RequestInit {
  const boundary = `----mailgun${crypto.randomUUID().replaceAll('-', '')}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const attachment of attachments) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${attachment.field}"; filename="${attachment.filename}"\r\nContent-Type: ${attachment.mimeType}\r\n\r\n`
      ),
      typeof attachment.bytes === 'string' ? encoder.encode(attachment.bytes) : attachment.bytes,
      encoder.encode('\r\n')
    );
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  return {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  };
}

function emailService(options: ServiceTestOptions = {}) {
  return testService(service, { serviceConfiguration, projectConfigurations: receivers, ...options });
}

async function forward(fields: Record<string, string>, attachments: Attachment[] = [], options?: ServiceTestOptions) {
  const kit = emailService(options);
  const res = await kit.fetch(webhook, mailgunForward(fields, attachments));
  return { res, deliveries: kit.deliveries, body: await res.text() };
}

function onlyDelivery(deliveries: Awaited<ReturnType<typeof forward>>['deliveries']) {
  assert.equal(deliveries.length, 1, 'the forward was not delivered exactly once');
  const [delivery] = deliveries;
  assert.ok(delivery);
  return delivery;
}

describe('incoming-email webhook', () => {
  it('delivers a signed Mailgun forward to the configuration whose local part is the recipient, attachments as files', async () => {
    const pdf = { field: 'attachment-1', filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: '%PDF-1.7' };
    const csv = { field: 'attachment-2', filename: 'lines.csv', mimeType: 'text/csv', bytes: 'sku,qty\nA,1\n' };

    const { res, deliveries } = await forward(signed(forwardedEmail()), [pdf, csv]);

    assert.equal(res.status, 200);
    const { event, to } = onlyDelivery(deliveries);
    assert.deepEqual(to, ['pe-1']);
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

  it('reads a urlencoded forward too', async () => {
    const kit = emailService();
    const res = await kit.fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(signed(forwardedEmail())).toString(),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(onlyDelivery(kit.deliveries).to, ['pe-1']);
  });

  it('dates the Event from the signed timestamp', async () => {
    const timestamp = nowSeconds();
    const { deliveries } = await forward(signed(forwardedEmail(), { timestamp }));

    assert.equal(onlyDelivery(deliveries).event.occurredAt, new Date(Number(timestamp) * 1000).toISOString());
  });

  it('refuses a forward signed with another key and delivers nothing', async () => {
    const { res, deliveries, body } = await forward(signed(forwardedEmail(), { key: 'someone-else' }));

    assert.equal(res.status, 401);
    assert.match(body, /signature does not match/);
    assert.deepEqual(deliveries, []);
  });

  it('refuses a forward signed more than five minutes ago, so a captured one cannot be replayed', async () => {
    const { res, body } = await forward(
      signed(forwardedEmail(), { timestamp: String(Math.floor(Date.now() / 1000) - 301) })
    );

    assert.equal(res.status, 401);
    assert.match(body, /window/);
  });

  it('answers 503 while the deployment has no signing key, so Mailgun retries once it is set', async () => {
    const { res, deliveries } = await forward(signed(forwardedEmail()), [], {
      serviceConfiguration: { receivingDomain: 'mail.example.com' },
    });

    assert.equal(res.status, 503);
    assert.deepEqual(deliveries, []);
  });

  it('refuses a forward with no signature fields', async () => {
    const { res } = await forward(forwardedEmail());

    assert.equal(res.status, 401);
  });

  it('answers 200 to mail for an address no configuration has, delivering nothing', async () => {
    const { res, deliveries } = await forward(signed(forwardedEmail({ recipient: 'nobody@mail.example.com' })));

    assert.equal(res.status, 200);
    assert.deepEqual(deliveries, []);
  });

  it('answers 503 so Mailgun retries when the receiver is over the Event cap', async () => {
    const { res } = await forward(signed(forwardedEmail()), [], { deliveryResults: { 'pe-1': 'over-cap' } });

    assert.equal(res.status, 503);
  });

  it('leaves out attachments over the configured size and lists them as omitted', async () => {
    const big = {
      field: 'attachment-1',
      filename: 'scan.tiff',
      mimeType: 'image/tiff',
      bytes: new Uint8Array(1024 * 1024 + 1),
    };
    const small = { field: 'attachment-2', filename: 'note.txt', mimeType: 'text/plain', bytes: 'hi' };
    const { deliveries } = await forward(signed(forwardedEmail()), [big, small]);

    const { event } = onlyDelivery(deliveries);
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
    const fromHeaders = await forward(signed(forwardedEmail({ 'Message-Id': '' })));
    const fromToken = await forward(
      signed(forwardedEmail({ 'Message-Id': '', 'message-headers': '[]', token: 'token-without-id' }))
    );

    assert.equal(onlyDelivery(fromHeaders.deliveries).event.key, '<invoice-42@customer.example>');
    assert.equal(onlyDelivery(fromToken.deliveries).event.key, 'token-without-id');
  });

  it('gives each recipient of a forward its own Event, delivered to its own configuration', async () => {
    const { deliveries } = await forward(
      signed(forwardedEmail({ recipient: 'aaaabbbbccccdddd@mail.example.com, k3p9x2mq7fd41abv@mail.example.com' }))
    );

    assert.deepEqual(
      deliveries.map(({ event, to }) => [event.data.address, to]),
      [
        ['aaaabbbbccccdddd', ['pe-2']],
        ['k3p9x2mq7fd41abv', ['pe-1']],
      ]
    );
  });

  it('reads the whole plain body as the text when Mailgun sends no stripped text', async () => {
    const fields = forwardedEmail();
    delete fields['stripped-text'];
    const { deliveries } = await forward(signed(fields));

    assert.equal(onlyDelivery(deliveries).event.data.text, 'Please find the invoice attached.\n\n> earlier reply');
  });

  it('keeps a missing subject and body as empty strings', async () => {
    const fields = forwardedEmail();
    delete fields.subject;
    delete fields['stripped-text'];
    delete fields['body-plain'];
    const { deliveries } = await forward(signed(fields));

    const { event } = onlyDelivery(deliveries);
    assert.equal(event.data.subject, '');
    assert.equal(event.data.text, '');
  });
});

describe('incoming-email address', () => {
  it('tells a connected Project environment its receiving address', async () => {
    const kit = testService(service, { serviceConfiguration, projectConfiguration: { localPart: 'k3p9x2mq7fd41abv' } });

    const res = await kit.fetch('/address');

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { address: 'k3p9x2mq7fd41abv@mail.example.com' });
  });

  it('refuses an environment with no address yet, naming the setting', async () => {
    const kit = testService(service, { serviceConfiguration, projectConfiguration: {} });

    const res = await kit.fetch('/address');

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('opsiforce-setting'), 'localPart');
  });
});
