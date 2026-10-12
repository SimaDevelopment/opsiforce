import { AssertionError } from 'node:assert';

import type { ServiceOrigin } from './check-manifest.ts';
import { containsSentSecret } from './echoed-secrets.ts';
import type { Field } from './fields.ts';
import { isPlainObject, withSecrets, type FormValues } from './form-levels.ts';
import { formValuesSchema } from './form-values.ts';
import type { AnyServiceHandlers, Caller, HookName, ServiceState } from './handlers.ts';
import { compileManifestValidators } from './input-validators.ts';
import { createOperationAdmission, defaultOperationSwitches } from './operation-admission.ts';
import { problem, problemMediaType, type ProblemDetails } from './problems.ts';
import { trimmedToReferencedItems } from './referenced-items.ts';
import {
  createServiceRuntime,
  formReferencing,
  type FormCallRoute,
  type ServiceResponse,
  type ServiceRoute,
} from './runtime.ts';
import { Secret } from './secret.ts';
import { createMemoryServiceState } from './service-state.ts';

export interface TestServiceOptions {
  serviceConfiguration?: FormValues;
  projectConfiguration?: FormValues;
  origin?: ServiceOrigin;
  caller?: Partial<Caller>;
  webhookUrl?: string;
}

export interface TestResponse<Body = unknown> {
  status: number;
  headers: Record<string, string>;
  body: Body;
  problem: ProblemDetails | undefined;
  callId: string;
}

export interface CallOptions {
  caller?: Partial<Caller>;
}

export interface TestOptionsRequest {
  query?: string;
  values?: FormValues;
  form?: 'serviceForm' | 'projectForm';
}

export interface TestFormCallRequest {
  values?: FormValues;
  form?: 'serviceForm' | 'projectForm';
}

export interface TestConfigurationChange {
  previous?: FormValues | null;
  current?: FormValues | null;
}

export interface TestInboundFile {
  field?: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array | string;
}

export interface TestInboundRequest {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  rawBody?: Uint8Array | string;
  files?: TestInboundFile[];
}

export interface TestEventFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface TestEvent {
  type: string;
  key: string;
  occurredAt: string;
  data: Record<string, unknown>;
  files?: TestEventFile[];
}

export interface TestInboundBody {
  events: TestEvent[];
  response?: { status?: number; headers?: Record<string, string>; body?: unknown };
}

interface WireInboundBody {
  events: (Omit<TestEvent, 'files'> & { files?: { name: string; mimeType: string; base64: string }[] })[];
  response?: TestInboundBody['response'];
}

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface UpstreamReplyInit {
  status?: number;
  headers?: Record<string, string>;
}

export type UpstreamResponder = (request: UpstreamRequest) => unknown;

export interface Upstream {
  reply(route: string, answer: UpstreamResponder, init?: UpstreamReplyInit): void;
  reply(route: string, answer?: unknown, init?: UpstreamReplyInit): void;
  readonly requests: readonly UpstreamRequest[];
}

export interface LogLine {
  level: string;
  message: string;
  callId: string;
  handler: string;
  [field: string]: unknown;
}

export interface TestService {
  call<Body = unknown>(operation: string, input?: unknown, options?: CallOptions): Promise<TestResponse<Body>>;
  options<Body = unknown>(name: string, request?: TestOptionsRequest): Promise<TestResponse<Body>>;
  info<Body = unknown>(name: string, request?: TestFormCallRequest): Promise<TestResponse<Body>>;
  button<Body = unknown>(name: string, request?: TestFormCallRequest): Promise<TestResponse<Body>>;
  hook(name: HookName, change: TestConfigurationChange): Promise<TestResponse<undefined>>;
  inbound(request?: TestInboundRequest): Promise<TestResponse<TestInboundBody>>;
  readonly upstream: Upstream;
  readonly state: ServiceState;
  readonly logs: readonly LogLine[];
}

export const testCaller: Caller = {
  tenantId: 'tenant_test',
  projectId: 'project_test',
  environmentId: 'environment_test',
  environment: 'development',
  via: 'agent',
};

export const testWebhookUrl = 'https://opsiforce.test/api/external-services/webhooks/test/development';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function configurationFits(form: Parameters<typeof formValuesSchema>[0], values: FormValues, name: string): void {
  const parsed = formValuesSchema(form).safeParse(values);
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  const path = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new TypeError(
    `testService: the ${name} does not fit service.json, so the platform would never deliver it (${path}${issue?.message ?? 'invalid'})`
  );
}

interface UpstreamRoute {
  method: string;
  target: URL;
  answer: unknown;
  init: UpstreamReplyInit;
}

function parseRoute(route: string): { method: string; target: URL } {
  const match = /^([A-Za-z]+)\s+(\S+)$/.exec(route.trim());
  const [, method, url] = match ?? [];
  if (!method || !url || !URL.canParse(url)) {
    throw new TypeError(`upstream.reply needs "METHOD https://host/path", got "${route}"`);
  }
  return { method: method.toUpperCase(), target: new URL(url) };
}

function routeMatches(route: UpstreamRoute, method: string, url: URL): boolean {
  if (route.method !== method) return false;
  if (route.target.origin !== url.origin || route.target.pathname !== url.pathname) return false;
  for (const [name, value] of route.target.searchParams) {
    if (!url.searchParams.getAll(name).includes(value)) return false;
  }
  return true;
}

function upstreamResponse(answer: unknown, init: UpstreamReplyInit): Response {
  if (answer instanceof Response) return answer.clone();
  const status = init.status ?? 200;
  const headers = new Headers(init.headers);
  if (answer === undefined || status === 204 || status === 304) return new Response(null, { status, headers });
  if (typeof answer === 'string' || answer instanceof Uint8Array) {
    return new Response(answer, { status, headers });
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(answer), { status, headers });
}

function untilAborted<T>(pending: T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function createUpstream() {
  const routes: UpstreamRoute[] = [];
  const requests: UpstreamRequest[] = [];
  let unexpected: string[] = [];

  const intercepted: typeof fetch = async (resource, options) => {
    const request = new Request(resource, options);
    const seen: UpstreamRequest = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: request.body === null ? '' : await request.text(),
    };
    requests.push(seen);
    const url = new URL(request.url);
    const route = routes.findLast((candidate) => routeMatches(candidate, request.method, url));
    if (!route) {
      unexpected.push(`${request.method} ${request.url}`);
      throw new TypeError(
        `unexpected upstream call ${request.method} ${request.url}; add upstream.reply('${request.method} ${url.origin}${url.pathname}', …)`
      );
    }
    const answer =
      typeof route.answer === 'function' ? await untilAborted(route.answer(seen), request.signal) : route.answer;
    return upstreamResponse(answer, route.init);
  };

  const upstream: Upstream = {
    reply(route, answer, init = {}) {
      routes.push({ ...parseRoute(route), answer, init });
    },
    get requests() {
      return requests;
    },
  };

  const around = async <Result>(run: () => Promise<Result>): Promise<Result> => {
    const original = globalThis.fetch;
    unexpected = [];
    globalThis.fetch = intercepted;
    let result: Result;
    try {
      result = await run();
    } finally {
      globalThis.fetch = original;
    }
    const calls = unexpected;
    unexpected = [];
    if (calls.length > 0) {
      throw new AssertionError({
        message: `The service made upstream calls no upstream.reply answers:\n${calls.map((call) => `  ${call}`).join('\n')}`,
        actual: calls,
        expected: [],
        operator: 'upstream.reply',
      });
    }
    return result;
  };

  return { upstream, around };
}

function testResponse<Body>(response: ServiceResponse, callId: string): TestResponse<Body> {
  const contentType = response.headers['content-type'] ?? '';
  const isJson = contentType === 'application/json' || contentType === problemMediaType;
  const body =
    response.body.byteLength === 0 ? undefined : isJson ? JSON.parse(decoder.decode(response.body)) : response.body;
  return {
    status: response.status,
    headers: response.headers,
    body: body as Body,
    problem: contentType === problemMediaType ? (body as ProblemDetails) : undefined,
    callId,
  };
}

function refusal<Body>(body: ProblemDetails, callId: string): TestResponse<Body> {
  return {
    status: body.status,
    headers: { 'content-type': problemMediaType },
    body: body as Body,
    problem: body,
    callId,
  };
}

function secretsIn(fields: readonly Field[] | undefined, values: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (value instanceof Secret) found.push(value.reveal());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isPlainObject(value)) Object.values(value).forEach(visit);
  };
  visit(withSecrets(fields, values));
  return found;
}

function bytesOf(value: Uint8Array | string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array();
  return typeof value === 'string' ? encoder.encode(value) : value;
}

function base64(value: Uint8Array | string | undefined): string {
  return Buffer.from(bytesOf(value)).toString('base64');
}

export function testService(
  manifest: unknown,
  handlers: AnyServiceHandlers,
  options: TestServiceOptions = {}
): TestService {
  const logs: LogLine[] = [];
  const state = createMemoryServiceState();
  const runtime = createServiceRuntime({
    manifest,
    handlers,
    origin: options.origin ?? 'custom',
    log: (line) => logs.push(JSON.parse(line) as LogLine),
    state: () => state,
  });
  const parsed = runtime.manifest;
  const validators = compileManifestValidators(parsed);
  const admission = createOperationAdmission(parsed, validators);

  const serviceConfiguration = options.serviceConfiguration ?? {};
  const storedProjectConfiguration = options.projectConfiguration ?? {};
  configurationFits(parsed.serviceForm ?? [], serviceConfiguration, 'serviceConfiguration');
  configurationFits(parsed.projectForm ?? [], storedProjectConfiguration, 'projectConfiguration');
  const projectConfiguration: FormValues = {
    operations: defaultOperationSwitches(parsed),
    ...storedProjectConfiguration,
  };

  const { upstream, around } = createUpstream();
  let calls = 0;
  const nextCallId = () => `call_test_${++calls}`;

  const context = (
    callId: string,
    caller: Partial<Caller> | undefined,
    delivered: FormValues = serviceConfiguration
  ) => ({
    callId,
    ...(caller === undefined ? {} : { caller: { ...testCaller, ...options.caller, ...caller } }),
    serviceConfiguration: delivered,
    projectConfiguration,
    webhookUrl: options.webhookUrl ?? testWebhookUrl,
  });

  const referencedBy = (...projectValues: (FormValues | null | undefined)[]) =>
    trimmedToReferencedItems(
      parsed.projectForm,
      serviceConfiguration,
      ...projectValues.filter((values): values is FormValues => isPlainObject(values))
    );

  const sentSecrets = (delivered: FormValues, ...projectValues: unknown[]) => [
    ...secretsIn(parsed.serviceForm, delivered),
    ...projectValues.flatMap((values) => secretsIn(parsed.projectForm, values)),
  ];

  const dispatch = async <Body>(
    route: ServiceRoute,
    name: string | undefined,
    body: unknown,
    callId: string,
    secrets: readonly string[]
  ): Promise<TestResponse<Body>> => {
    const response = await around(() => runtime.dispatch({ route, name, body }));
    if (containsSentSecret(response, secrets)) {
      return refusal<Body>(
        problem({
          status: 502,
          code: 'secret-in-response',
          detail: 'The service answered with one of its own secrets, so the answer was withheld.',
          callId,
        }),
        callId
      );
    }
    return testResponse<Body>(response, callId);
  };

  const formCall = async <Body>(route: FormCallRoute, name: string, request: TestOptionsRequest) => {
    const callId = nextCallId();
    const form = request.form ?? formReferencing(parsed, route, name);
    const values = request.values ?? {};
    const delivered = form === 'projectForm' ? referencedBy(values) : serviceConfiguration;
    const secrets =
      form === 'projectForm'
        ? sentSecrets(delivered, values)
        : [...sentSecrets(delivered), ...secretsIn(parsed.serviceForm, values)];
    return dispatch<Body>(
      route,
      name,
      { context: context(callId, form === 'projectForm' ? {} : undefined, delivered), ...request },
      callId,
      secrets
    );
  };

  const checkEvents = (body: WireInboundBody) => {
    for (const event of body.events) {
      const validate = validators.events[event.type];
      if (!validate) {
        throw new AssertionError({
          message: `inbound returned the Event type "${event.type}", which service.json does not declare`,
        });
      }
      if (!validate(structuredClone(event.data))) {
        const error = validate.errors?.[0];
        throw new AssertionError({
          message: `inbound returned a "${event.type}" Event whose data does not fit service.json: ${error?.instancePath || 'data'} ${error?.message ?? 'is invalid'}`,
          actual: event.data,
        });
      }
    }
  };

  return {
    upstream,
    state,
    logs,

    async call<Body>(operation: string, input: unknown = {}, callOptions: CallOptions = {}) {
      const callId = nextCallId();
      const admitted = admission.admit({ operation, input, projectConfiguration, serviceConfiguration });
      if (!admitted.admitted) return refusal<Body>({ ...admitted.problem, callId }, callId);
      const delivered = referencedBy(projectConfiguration);
      return dispatch<Body>(
        'operations',
        operation,
        { context: context(callId, callOptions.caller ?? {}, delivered), input: admitted.input },
        callId,
        sentSecrets(delivered, projectConfiguration)
      );
    },

    options<Body>(name: string, request: TestOptionsRequest = {}) {
      return formCall<Body>('options', name, request);
    },

    info<Body>(name: string, request: TestFormCallRequest = {}) {
      return formCall<Body>('info', name, request);
    },

    button<Body>(name: string, request: TestFormCallRequest = {}) {
      return formCall<Body>('buttons', name, request);
    },

    async hook(name, change) {
      const callId = nextCallId();
      const previous = change.previous ?? null;
      const current = change.current ?? null;
      const ofProject = name === 'onProjectConfigurationSaved';
      const delivered = ofProject ? referencedBy(previous, current) : serviceConfiguration;
      const secrets = ofProject
        ? sentSecrets(delivered, previous, current)
        : [
            ...sentSecrets(delivered),
            ...secretsIn(parsed.serviceForm, previous),
            ...secretsIn(parsed.serviceForm, current),
          ];
      return dispatch<undefined>(
        'hooks',
        name,
        { context: context(callId, ofProject ? {} : undefined, delivered), previous, current },
        callId,
        secrets
      );
    },

    async inbound(request = {}) {
      const callId = nextCallId();
      const response = await dispatch<TestInboundBody>(
        'inbound',
        undefined,
        {
          context: context(callId, undefined),
          request: {
            method: request.method ?? 'POST',
            headers: request.headers ?? {},
            query: request.query ?? {},
            rawBody: base64(request.rawBody),
            files: (request.files ?? []).map(({ bytes, ...described }) =>
              Object.assign(described, { base64: base64(bytes) })
            ),
          },
        },
        callId,
        sentSecrets(serviceConfiguration)
      );
      if (response.status !== 200) return response;
      const body = response.body as unknown as WireInboundBody;
      checkEvents(body);
      const events = body.events.map(
        ({ files, ...event }): TestEvent => ({
          ...event,
          ...(files === undefined
            ? {}
            : {
                files: files.map((entry) => ({
                  name: entry.name,
                  mimeType: entry.mimeType,
                  bytes: new Uint8Array(Buffer.from(entry.base64, 'base64')),
                })),
              }),
        })
      );
      return { ...response, body: { ...body, events } };
    },
  };
}
