import { testService, type ServiceTestOptions } from '@opsiforce/external-service-sdk/testing';

import service from '../service.ts';

export { testServiceWebhookUrl as webhookUrl } from '@opsiforce/external-service-sdk/testing';

export const apiUrl = 'https://whapi.example.com';

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

export const serviceConfiguration = { apiUrl, channels: [sales, support] };

export interface WhapiRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Answer = unknown;

type Responder = Answer | ((request: WhapiRequest) => Answer | Promise<Answer>);

interface FakeRoute {
  method: string;
  url: string;
  responder: Responder;
  init: ResponseInit;
}

export interface FakeWhapi {
  readonly requests: WhapiRequest[];
  reply(route: string, responder: Responder, init?: ResponseInit): void;
}

let currentFake: { routes: FakeRoute[]; requests: WhapiRequest[] } | null = null;

const realFetch = globalThis.fetch;

function withoutQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function responseOf(answer: Answer, init: ResponseInit): Response {
  if (answer instanceof Response) return answer;
  if (answer instanceof Uint8Array || typeof answer === 'string') return new Response(answer as BodyInit, init);
  return Response.json(answer, init);
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const fake = currentFake;
  if (!fake) return realFetch(input, init);
  const route = fake.routes.find(
    (candidate) => candidate.method === request.method && candidate.url === withoutQuery(request.url)
  );
  if (!route) throw new TypeError(`${request.method} ${request.url} is not faked in this test`);
  const recorded: WhapiRequest = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: request.body === null ? '' : await request.text(),
  };
  fake.requests.push(recorded);
  const aborted = new Promise<never>((_, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
  const answer = await Promise.race([
    typeof route.responder === 'function' ? route.responder(recorded) : route.responder,
    aborted,
  ]);
  return responseOf(answer, route.init);
};

function fakeWhapi(): FakeWhapi {
  const fake = { routes: [] as FakeRoute[], requests: [] as WhapiRequest[] };
  currentFake = fake;
  return {
    requests: fake.requests,
    reply(route, responder, init = {}) {
      const [method = 'GET', url = ''] = route.split(' ');
      fake.routes.push({ method, url, responder, init });
    },
  };
}

const wellKnown = '/.well-known/opsiforce';

function posted(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function whatsapp(options: ServiceTestOptions = {}) {
  const upstream = fakeWhapi();
  const kit = testService(service, { serviceConfiguration, ...options });
  return {
    upstream,
    deliveries: kit.deliveries,
    webhook: (body: string, headers: Record<string, string>) =>
      kit.fetch(`${wellKnown}/webhook`, { method: 'POST', headers, body }),
    options: (name: string, draft: { form: string; values: unknown; item?: string; query?: string }) =>
      kit.fetch(`${wellKnown}/options/${name}`, posted(draft)),
    info: (name: string, draft: { form: string; values: unknown; item?: string }) =>
      kit.fetch(`${wellKnown}/info/${name}`, posted(draft)),
    button: (name: string, draft: { form: string; values: unknown; item?: string }) =>
      kit.fetch(`${wellKnown}/buttons/${name}`, posted(draft)),
    hook: (name: string, change: { previous: unknown; current: unknown }) =>
      kit.fetch(`${wellKnown}/hooks/${name}`, posted(change)),
  };
}
