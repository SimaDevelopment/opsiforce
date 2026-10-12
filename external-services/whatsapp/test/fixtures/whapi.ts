import { sales } from '../whatsapp.ts';

export const textMessage = {
  id: 'wamid.text-1',
  from_me: false,
  type: 'text',
  chat_id: '491701234567@s.whatsapp.net',
  chat_name: 'Anna',
  timestamp: 1791460800,
  source: 'mobile',
  text: { body: 'Two boxes, please' },
  from: '491701234567',
  from_name: 'Anna',
};

export function webhook(messages: unknown[], { channelId = sales.channelId } = {}) {
  return JSON.stringify({ messages, event: { type: 'messages', event: 'post' }, channel_id: channelId });
}

export function signedHeaders(secret = sales.webhookSecret) {
  return { 'content-type': 'application/json', 'x-opsiforce-webhook-secret': secret };
}

export function settingsWith(webhooks: unknown[]) {
  return { webhooks };
}
