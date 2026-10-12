import { defineHandlers, ServiceError } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

export default defineHandlers<Manifest>({
  manifestHash,
  options: {
    listChats: ({ values }) => [{ value: 'chat_1', label: `Chats of ${String(values.channel)}` }],
  },
  info: {
    webhookStatus: (_request, ctx) => {
      const channel = ctx.serviceConfiguration.channels?.[0];
      return { text: channel ? `Webhook on ${channel.label}` : 'No number', level: channel ? 'success' : 'warning' };
    },
  },
  buttons: {
    showQr: () => ({ link: 'https://whapi.cloud/qr', label: 'Open QR code' }),
  },
  inbound: (request, ctx) => {
    const signature = request.headers['x-whapi-signature'];
    const expected = ctx.serviceConfiguration.channels?.[0]?.webhookSecret?.reveal();
    if (!signature || signature !== expected) {
      throw new ServiceError({ status: 401, code: 'bad-signature', detail: 'The webhook signature does not match' });
    }
    return {
      events: [
        {
          type: 'message.received',
          key: 'msg_1',
          occurredAt: '2026-10-08T10:00:00Z',
          data: { channel: 'li_sales', chatId: 'chat_1', text: 'hello' },
        },
      ],
    };
  },
});
