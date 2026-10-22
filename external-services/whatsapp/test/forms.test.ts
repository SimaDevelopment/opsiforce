import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { settingsWith } from './fixtures/whapi.ts';
import { apiUrl, sales, webhookUrl, whatsapp } from './whatsapp.ts';

const salesOnly = { apiUrl, channels: [sales] };

function salesForm(values: unknown = salesOnly) {
  return { form: 'serviceForm', values, item: sales.id };
}

describe('whatsapp form calls', () => {
  it('lists the picked number’s chats and groups, filtered by the search', async () => {
    const service = whatsapp({ serviceConfiguration: salesOnly });
    service.upstream.reply(`GET ${apiUrl}/chats`, {
      chats: [
        { id: '491701234567@s.whatsapp.net', name: 'Anna', type: 'contact' },
        { id: '491709999999@s.whatsapp.net', name: 'Bob', type: 'contact' },
        { id: '120363000000000000@g.us', name: null, type: 'group' },
      ],
    });
    service.upstream.reply(`GET ${apiUrl}/groups`, { groups: [{ id: '120363000000000000@g.us', name: 'Orders' }] });
    const draft = {
      form: 'projectForm',
      values: { channels: [{ id: 'li_item', channel: 'li_sales' }] },
      item: 'li_item',
    };

    const all = await service.options('listChats', draft);
    const searched = await service.options('listChats', { ...draft, query: 'ord' });

    assert.deepEqual(await all.json(), [
      { value: '120363000000000000@g.us', label: 'Orders', description: 'Group' },
      { value: '491701234567@s.whatsapp.net', label: 'Anna', description: '491701234567' },
      { value: '491709999999@s.whatsapp.net', label: 'Bob', description: '491709999999' },
    ]);
    assert.deepEqual(await searched.json(), [
      { value: '120363000000000000@g.us', label: 'Orders', description: 'Group' },
    ]);
    assert.equal(service.upstream.requests[0]?.headers.authorization, 'Bearer sales-api-token');
  });

  it('lists no chats before a number is picked', async () => {
    const res = await whatsapp().options('listChats', {
      form: 'projectForm',
      values: { channels: [{ id: 'li_item' }] },
      item: 'li_item',
    });

    assert.deepEqual(await res.json(), []);
  });

  it('reports the webhook as registered when Whapi holds this deployment’s URL and secret', async () => {
    const service = whatsapp();
    service.upstream.reply(
      `GET ${apiUrl}/settings`,
      settingsWith([
        {
          url: webhookUrl,
          headers: { 'X-Opsiforce-Webhook-Secret': 'sales-webhook-secret' },
          events: [{ type: 'messages', method: 'post' }],
        },
      ])
    );

    const res = await service.info('webhookStatus', salesForm());

    assert.deepEqual(await res.json(), { text: 'Registered with Whapi', level: 'success' });
  });

  it('warns when Whapi holds another secret, URL or no webhook at all', async () => {
    const cases = [
      [
        [
          {
            url: webhookUrl,
            headers: { 'X-Opsiforce-Webhook-Secret': 'old' },
            events: [{ type: 'messages', method: 'post' }],
          },
        ],
        /secret/,
      ],
      [[{ url: 'https://elsewhere.example.com/hook', events: [] }], /another URL/],
      [[], /No webhook/],
      [
        [{ url: webhookUrl, headers: { 'X-Opsiforce-Webhook-Secret': 'sales-webhook-secret' }, events: [] }],
        /messages/,
      ],
    ] as const;
    for (const [webhooks, expected] of cases) {
      const service = whatsapp();
      service.upstream.reply(`GET ${apiUrl}/settings`, settingsWith([...webhooks]));

      const body = (await (await service.info('webhookStatus', salesForm())).json()) as { text: string; level: string };

      assert.equal(body.level, 'warning');
      assert.match(body.text, expected);
    }
  });

  it('says why when Whapi cannot be asked', async () => {
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, { error: { message: 'Unauthorized' } }, { status: 401 });

    const body = (await (await service.info('webhookStatus', salesForm())).json()) as { text: string; level: string };

    assert.equal(body.level, 'error');
    assert.match(body.text, /Sales number: Whapi GET \/settings answered 401/);
  });

  it('asks to save a number before its webhook can be checked', async () => {
    const unsaved = { id: 'li_new', channelId: 'NEW-1', label: 'New', apiToken: 'token' };
    const res = await whatsapp().info('webhookStatus', {
      form: 'serviceForm',
      values: { apiUrl, channels: [unsaved] },
      item: unsaved.id,
    });

    assert.deepEqual(await res.json(), { text: 'Save the number to register its webhook.', level: 'info' });
  });

  it('shows the QR code a number is linked with', async () => {
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/users/login`, {
      status: 'OK',
      type: 'qr',
      base64: 'data:image/png;base64,iVBORw0KGgo=',
      expire: 20,
    });

    const res = await service.button('showQr', salesForm());

    assert.deepEqual(await res.json(), {
      image: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' },
      caption: 'Scan with WhatsApp on the phone of Sales number within 20 seconds.',
    });
  });

  it('says so when the number is already linked', async () => {
    const service = whatsapp();
    service.upstream.reply(
      `GET ${apiUrl}/users/login`,
      { error: { code: 409, message: 'Channel already authenticated' } },
      { status: 409 }
    );

    const res = await service.button('showQr', salesForm());

    assert.deepEqual(await res.json(), { message: 'Sales number is already linked to WhatsApp.', level: 'success' });
  });
});
