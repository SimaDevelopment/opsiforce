import { readFileSync } from 'node:fs';

import { testService, type TestServiceOptions } from '@opsiforce/external-service-sdk/testing';

import handlers from '../handlers.ts';

const manifest = JSON.parse(readFileSync(new URL('../service.json', import.meta.url), 'utf8'));

export const apiUrl = 'https://whapi.example.com';

export const webhookUrl = 'https://opsiforce.example.com/api/external-services/webhooks/whatsapp';

export const sales = {
  id: 'li_sales',
  channelId: 'SALES-7Q2',
  label: 'Sales number',
  apiToken: 'sales-api-token',
  webhookSecret: 'sales-webhook-secret',
};

export const support = {
  id: 'li_support',
  channelId: 'SUPPORT-4K1',
  label: 'Support number',
  apiToken: 'support-api-token',
  webhookSecret: 'support-webhook-secret',
};

const serviceConfiguration = { apiUrl, channels: [sales, support] };

export function whatsapp(options: TestServiceOptions = {}) {
  return testService(manifest, handlers, { serviceConfiguration, origin: 'built_in', webhookUrl, ...options });
}
