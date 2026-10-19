import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { settingsWith } from './fixtures/whapi.ts';
import { apiUrl, sales, support, webhookUrl, whatsapp } from './whatsapp.ts';

describe('whatsapp onServiceConfigurationSaved', () => {
  it('registers the webhook with Whapi for a new number, keeping webhooks that are not Opsiforce’s', async () => {
    const foreign = { url: 'https://crm.example.com/hook', events: [{ type: 'messages', method: 'post' }] };
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, settingsWith([foreign]));
    service.upstream.reply(`PATCH ${apiUrl}/settings`, {});

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: { apiUrl, channels: [support] },
      current: { apiUrl, channels: [support, sales] },
    });

    assert.equal(res.status, 204);
    const patch = service.upstream.requests.find((request) => request.method === 'PATCH');
    assert.equal(patch?.headers.authorization, 'Bearer sales-api-token');
    assert.deepEqual(JSON.parse(patch?.body || '{}'), {
      webhooks: [
        foreign,
        {
          url: webhookUrl,
          mode: 'body',
          headers: { 'X-Opsiforce-Webhook-Secret': 'sales-webhook-secret' },
          events: [{ type: 'messages', method: 'post' }],
        },
      ],
    });
  });

  it('re-registers a number whose webhook secret was rotated and leaves unchanged numbers alone', async () => {
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, settingsWith([]));
    service.upstream.reply(`PATCH ${apiUrl}/settings`, {});

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: { apiUrl, channels: [sales, support] },
      current: { apiUrl, channels: [{ ...sales, webhookSecret: 'rotated-secret' }, support] },
    });

    assert.equal(res.status, 204);
    const patches = service.upstream.requests.filter((request) => request.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.match(patches[0]?.body ?? '', /rotated-secret/);
  });

  it('replaces Opsiforce’s earlier webhook instead of adding a second one', async () => {
    const earlier = {
      url: 'https://old.example.com/api/external-services/webhooks/whatsapp',
      headers: { 'X-Opsiforce-Webhook-Secret': 'old' },
      events: [{ type: 'messages', method: 'post' }],
    };
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, settingsWith([earlier]));
    service.upstream.reply(`PATCH ${apiUrl}/settings`, {});

    await service.hook('onServiceConfigurationSaved', { previous: null, current: { apiUrl, channels: [sales] } });

    const patch = service.upstream.requests.find((request) => request.method === 'PATCH');
    assert.deepEqual(
      JSON.parse(patch?.body || '{}').webhooks.map((entry: { url: string }) => entry.url),
      [webhookUrl]
    );
  });

  it('makes no Whapi call when only a label changed', async () => {
    const service = whatsapp();

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: { apiUrl, channels: [sales] },
      current: { apiUrl, channels: [{ ...sales, label: 'Sales (EU)' }] },
    });

    assert.equal(res.status, 204);
    assert.deepEqual(service.upstream.requests, []);
  });

  it('fails the save hook when Whapi refuses, so the operator sees Retry', async () => {
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, { error: { message: 'Unauthorized' } }, { status: 401 });

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: null,
      current: { apiUrl, channels: [sales] },
    });

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('opsiforce-outcome'), 'failed');
  });

  it('still registers the other numbers when Whapi refuses one, then fails the hook', async () => {
    const service = whatsapp();
    const refusedForSupport = (request: { headers: Record<string, string> }) =>
      request.headers.authorization === 'Bearer support-api-token'
        ? new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 })
        : settingsWith([]);
    service.upstream.reply(`GET ${apiUrl}/settings`, refusedForSupport);
    service.upstream.reply(`PATCH ${apiUrl}/settings`, {});

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: null,
      current: { apiUrl, channels: [support, sales] },
    });

    assert.equal(res.status, 502);
    const patches = service.upstream.requests.filter((request) => request.method === 'PATCH');
    assert.deepEqual(
      patches.map((patch) => patch.headers.authorization),
      ['Bearer sales-api-token']
    );
  });

  it('takes Opsiforce’s webhook off a removed number, keeping the ones that are not Opsiforce’s', async () => {
    const foreign = { url: 'https://crm.example.com/hook', events: [{ type: 'messages', method: 'post' }] };
    const ours = { url: webhookUrl, headers: { 'X-Opsiforce-Webhook-Secret': support.webhookSecret } };
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, settingsWith([foreign, ours]));
    service.upstream.reply(`PATCH ${apiUrl}/settings`, {});

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: { apiUrl, channels: [sales, support] },
      current: { apiUrl, channels: [sales] },
    });

    assert.equal(res.status, 204);
    const patch = service.upstream.requests.find((request) => request.method === 'PATCH');
    assert.equal(patch?.headers.authorization, 'Bearer support-api-token');
    assert.deepEqual(JSON.parse(patch?.body || '{}'), { webhooks: [foreign] });
  });

  it('leaves another deployment’s webhook on a removed number', async () => {
    const elsewhere = {
      url: 'https://other.example.com/api/external-services/webhooks/whatsapp',
      headers: { 'X-Opsiforce-Webhook-Secret': 'their-secret' },
    };
    const ours = { url: webhookUrl, headers: { 'X-Opsiforce-Webhook-Secret': support.webhookSecret } };
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, settingsWith([elsewhere, ours]));
    service.upstream.reply(`PATCH ${apiUrl}/settings`, {});

    await service.hook('onServiceConfigurationSaved', {
      previous: { apiUrl, channels: [sales, support] },
      current: { apiUrl, channels: [sales] },
    });

    const patch = service.upstream.requests.find((request) => request.method === 'PATCH');
    assert.deepEqual(JSON.parse(patch?.body || '{}'), { webhooks: [elsewhere] });
  });

  it('takes Opsiforce’s webhook off every number when the Service configuration is cleared', async () => {
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/settings`, (request: { headers: Record<string, string> }) =>
      settingsWith([
        {
          url: webhookUrl,
          headers: {
            'X-Opsiforce-Webhook-Secret':
              request.headers.authorization === 'Bearer sales-api-token' ? sales.webhookSecret : support.webhookSecret,
          },
        },
      ])
    );
    service.upstream.reply(`PATCH ${apiUrl}/settings`, {});

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: { apiUrl, channels: [sales, support] },
      current: null,
    });

    assert.equal(res.status, 204);
    const patches = service.upstream.requests.filter((request) => request.method === 'PATCH');
    assert.deepEqual(
      patches.map((patch) => [patch.headers.authorization, JSON.parse(patch.body || '{}')]),
      [
        ['Bearer sales-api-token', { webhooks: [] }],
        ['Bearer support-api-token', { webhooks: [] }],
      ]
    );
  });

  it('still saves when Whapi refuses to take the webhook off a removed number', async () => {
    const service = whatsapp();
    service.upstream.reply(
      `GET ${apiUrl}/settings`,
      () => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 })
    );

    const res = await service.hook('onServiceConfigurationSaved', {
      previous: { apiUrl, channels: [sales, support] },
      current: { apiUrl, channels: [sales] },
    });

    assert.equal(res.status, 204);
  });
});
