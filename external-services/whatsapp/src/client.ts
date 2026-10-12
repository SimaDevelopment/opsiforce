import { timingSafeEqual } from 'node:crypto';

import { ServiceError, upstreamUnauthorized } from '@opsiforce/external-service-sdk';

import type { ServiceConfiguration } from '../service.types.ts';

export type Channel = NonNullable<ServiceConfiguration['channels']>[number];

export interface WhapiWebhook {
  url?: string;
  mode?: string;
  headers?: Record<string, string>;
  events?: { type?: string; method?: string }[];
}

export const webhookSecretHeader = 'X-Opsiforce-Webhook-Secret';

const defaultApiUrl = 'https://gate.whapi.cloud';

const chatPageSize = 500;

const maxChatPages = 10;

export class WhapiRefusal extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function sameText(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function apiBaseOf(configuration: ServiceConfiguration): string {
  return (configuration.apiUrl ?? defaultApiUrl).replace(/\/+$/, '');
}

export async function whapi<Body>(
  configuration: ServiceConfiguration,
  channel: Channel,
  request: { method: string; path: string; signal: AbortSignal; body?: unknown }
): Promise<Body> {
  const { method, path, body } = request;
  const response = await fetch(`${apiBaseOf(configuration)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${channel.apiToken.reveal()}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: request.signal,
  }).catch((error: unknown) => {
    throw new WhapiRefusal(0, `Whapi is unreachable: ${errorText(error)}`);
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new WhapiRefusal(response.status, `Whapi ${method} ${path} answered ${response.status}: ${detail}`);
  }
  return (await response.json()) as Body;
}

export function asServiceError(error: unknown, channel: Channel): unknown {
  if (!(error instanceof WhapiRefusal)) return error;
  const detail = `${channel.label}: ${error.message}`;
  if (error.status === 401 || error.status === 403) return upstreamUnauthorized(detail);
  return new ServiceError({ status: 502, code: 'upstream-failed', detail });
}

export function channelOf(configuration: ServiceConfiguration, id: unknown): Channel | undefined {
  return (configuration.channels ?? []).find((channel) => channel.id === id);
}

export function registeredSecretOf(webhook: WhapiWebhook): string | undefined {
  const name = Object.keys(webhook.headers ?? {}).find(
    (candidate) => candidate.toLowerCase() === webhookSecretHeader.toLowerCase()
  );
  return name === undefined ? undefined : webhook.headers?.[name];
}

export async function registeredWebhooks(configuration: ServiceConfiguration, channel: Channel, signal: AbortSignal) {
  const settings = await whapi<{ webhooks?: WhapiWebhook[] }>(configuration, channel, {
    method: 'GET',
    path: '/settings',
    signal,
  });
  return settings.webhooks ?? [];
}

export async function namedPages(
  configuration: ServiceConfiguration,
  channel: Channel,
  collection: 'chats' | 'groups',
  signal: AbortSignal,
  names: Map<string, string | undefined>
): Promise<void> {
  for (let page = 0; page < maxChatPages; page++) {
    const body = await whapi<Record<string, { id?: string; name?: string | null }[] | undefined>>(
      configuration,
      channel,
      { method: 'GET', path: `/${collection}?count=${chatPageSize}&offset=${page * chatPageSize}`, signal }
    );
    const entries = body[collection] ?? [];
    for (const entry of entries) {
      if (entry.id) names.set(entry.id, asText(entry.name) ?? names.get(entry.id));
    }
    if (entries.length < chatPageSize) return;
  }
}
