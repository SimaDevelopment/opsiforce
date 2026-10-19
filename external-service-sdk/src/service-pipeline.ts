import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { callerIdentityHeader, verifyCallerIdentity, type CallerIdentity } from './caller-identity.ts';
import {
  builtInCounterNames,
  builtInCounters,
  counterLimits,
  defaultBodyLimit,
  upstreamLookups,
  type Configurations,
  type DefinedService,
  type DeliveryResult,
  type ProjectConfigurationEntry,
  type Route,
  type RouteContext,
  type DeliveredEvent,
  type ServiceHandle,
  type Upstream,
  type UpstreamLookup,
  type WebhookContext,
} from './define-service.ts';
import type { Field } from './fields.ts';
import { createFormHandlers, formHandlerPathOf } from './form-handlers.ts';
import { fieldNamed, valueFieldsOf, withSecrets, type FormValues } from './form-levels.ts';
import { BodyTooLarge, InboundBody } from './inbound-body.ts';
import {
  failureMessages,
  issueVerdict,
  isVerdict,
  outcomeHeader,
  refusalOf,
  refusalResponse,
  refusalStatuses,
  type CallOutcome,
  type Refusal,
  type Verdict,
} from './refusals.ts';
import { decodedSegments, isSafePath, matchRoutePattern } from './route-patterns.ts';
import type { AtomicServiceState } from './service-state.ts';
import {
  decodedResponse,
  nullBodyStatuses,
  preparedUpstreamCall,
  strippedCallerHeaders,
  pathBelowMount,
  type UpstreamCall,
  type UpstreamTransport,
} from './upstream-forwarding.ts';
import { describeService, wellKnownPath } from './well-known.ts';

export interface RequestConfiguration {
  serviceConfiguration: FormValues;
  projectConfiguration: FormValues | null;
  missing?: { serviceForm?: readonly string[]; projectForm?: readonly string[] };
  settingsLink?: string;
}

export interface ConfigurationSource {
  forCaller(caller: CallerIdentity, callerIdentity: string): Promise<RequestConfiguration>;
  service(): Promise<FormValues>;
  projectConfigurations(): Promise<ProjectConfigurationEntry[]>;
  forget?(caller: CallerIdentity): void;
}

export const callLogOutcomes = ['proxied', 'handled', 'not supported', 'not allowed', 'failed'] as const;

export type CallLogOutcome = (typeof callLogOutcomes)[number];

export interface CallRow {
  requestId: string;
  time: string;
  callerKind: CallerIdentity['kind'];
  projectId: string | null;
  projectEnvironmentId: string | null;
  environment: string | null;
  method: string;
  path: string;
  route: string | null;
  outcome: CallLogOutcome;
  reason: string | null;
  status: number;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  notes: Record<string, unknown>;
}

export interface CountEntry {
  name: string;
  label: string;
  description: string | null;
  n: number;
  projectId: string | null;
  projectEnvironmentId: string | null;
  environment: string | null;
}

export interface ServiceRecords {
  call(row: CallRow): void;
  count(entry: CountEntry): void;
}

export interface EventDelivery {
  deliver(event: DeliveredEvent, to: readonly string[], callerIdentity?: string): Promise<DeliveryResult[]>;
}

export interface ServicePlatform {
  gatewayKey: string;
  configurations: ConfigurationSource;
  upstreams: UpstreamTransport;
  state: AtomicServiceState;
  records?: ServiceRecords;
  events?: EventDelivery;
  webhookUrl?: string;
  now?: () => number;
}

export interface IncomingCall {
  method: string;
  target: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}

export interface ServicePipeline {
  readonly service: ServiceHandle;
  answer(call: IncomingCall): Promise<Response>;
  answerUpgrade(call: IncomingCall): Promise<Response | UpstreamCall>;
}

const noRecords: ServiceRecords = { call: () => undefined, count: () => undefined };

const eventsNotAvailable: EventDelivery = {
  deliver: () => Promise.reject(new Error('service.deliver is not available in this runtime yet')),
};

export function secretValuesOf(fields: readonly Field[] | undefined, values: unknown): string[] {
  if (typeof values !== 'object' || values === null) return [];
  const record = values as FormValues;
  return valueFieldsOf(fields ?? []).flatMap((field) => {
    const value = record[field.key];
    if (field.type === 'secret' && typeof value === 'string' && value !== '') return [value];
    if (field.type === 'list' && Array.isArray(value)) return value.flatMap((item) => secretValuesOf(field.item, item));
    return [];
  });
}

const minCheckedSecretLength = 8;

function containsSecret(texts: readonly string[], secrets: readonly string[]): boolean {
  return secrets
    .filter((secret) => secret.length >= minCheckedSecretLength)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
    .some((secret) => texts.some((text) => text.includes(secret)));
}

function sentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function linkToField(settingsLink: string | undefined, key: string): string | null {
  if (settingsLink === undefined || settingsLink === '') return null;
  return `${settingsLink}${settingsLink.includes('?') ? '&' : '?'}field=${encodeURIComponent(key)}`;
}

function splitTarget(target: string): { path: string; rawQuery: string } {
  const index = target.indexOf('?');
  return index === -1
    ? { path: target, rawQuery: '' }
    : { path: target.slice(0, index), rawQuery: target.slice(index + 1) };
}

type StepFailureKind = 'failed' | 'upstreamUnreachable' | 'secretInAnswer';

class StepFailure extends Error {
  readonly reason: string;
  readonly kind: StepFailureKind;

  constructor(reason: string, kind: StepFailureKind = 'failed') {
    super(reason);
    this.reason = reason;
    this.kind = kind;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const webhookPath = `${wellKnownPath}/webhook`;

export const eventCapRetryAfterSeconds = 60;

interface DeliveredCount {
  stored: number;
  duplicate: number;
}

interface RequestScope {
  callerIdentity?: string;
  readonly undelivered: DeliveryResult[];
  readonly delivered: Map<string, DeliveredCount>;
}

function undeliveredReason(undelivered: readonly DeliveryResult[]): string {
  return undelivered
    .map(({ projectEnvironmentId, result }) =>
      result === 'over-cap' ? `${projectEnvironmentId} over the Event cap` : `${projectEnvironmentId} is not connected`
    )
    .join('; ');
}

function environments(count: number): string {
  return `${count} environment${count === 1 ? '' : 's'}`;
}

function deliveredReason(delivered: ReadonlyMap<string, DeliveredCount>): string | null {
  if (delivered.size === 0) return null;
  return [...delivered]
    .map(
      ([type, { stored, duplicate }]) =>
        `${type} → ${environments(stored)}${duplicate === 0 ? '' : `, ${duplicate} already had it`}`
    )
    .join('; ');
}

function isWebhookPath(path: string): boolean {
  return path === webhookPath || path.startsWith(`${webhookPath}/`);
}

interface CallRecording {
  readonly requestId: string;
  readonly startedAt: number;
  readonly method: string;
  readonly path: string;
  readonly notes: Record<string, unknown>;
  caller?: CallerIdentity;
  route: string | null;
  outcome?: CallOutcome;
  reason: string | null;
}

const callLogOutcomeOf: Record<CallOutcome, CallLogOutcome> = {
  proxied: 'proxied',
  handled: 'handled',
  'not supported': 'not supported',
  'not allowed': 'not allowed',
  'not connected': 'not allowed',
  incomplete: 'not allowed',
  failed: 'failed',
  unidentified: 'failed',
};

function outcomeOfAnswer(answer: Response): CallOutcome {
  const stated = answer.headers.get(outcomeHeader);
  return stated !== null && stated in callLogOutcomeOf ? (stated as CallOutcome) : 'handled';
}

interface CountedStream {
  stream: ReadableStream<Uint8Array>;
  bytes(): number;
}

function countedStream(
  body: ReadableStream<Uint8Array>,
  onEnd: (bytes: number, problem: string | null) => void = () => undefined
): CountedStream {
  const reader = body.getReader();
  let bytes = 0;
  let ended = false;
  const end = (problem: string | null) => {
    if (ended) return;
    ended = true;
    onEnd(bytes, problem);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            end(null);
            controller.close();
            return;
          }
          bytes += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          end(`the stream broke off: ${errorText(error)}`);
          controller.error(error);
        }
      },
      cancel(reason) {
        end(null);
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, bytes: () => bytes };
}

export function createServicePipeline(defined: DefinedService, platform: ServicePlatform): ServicePipeline {
  const { definition, manifest } = defined;
  const records = platform.records ?? noRecords;
  const events = platform.events ?? eventsNotAvailable;
  const now = platform.now ?? Date.now;
  const counters = definition.counters ?? {};
  const requestScope = new AsyncLocalStorage<RequestScope>();

  const declaredCounter = (name: string, n: number) => {
    const declaration = Object.hasOwn(counters, name) ? counters[name] : undefined;
    if ((builtInCounterNames as readonly string[]).includes(name) || declaration === undefined) {
      throw new RangeError(`count('${name}'): declare the counter in defineService({ counters })`);
    }
    if (!Number.isInteger(n) || n < 1 || n > counterLimits.maxCount) {
      throw new RangeError(`count('${name}', ${n}): counts are whole numbers from 1 to ${counterLimits.maxCount}`);
    }
    return { name, label: declaration.label, description: declaration.description ?? null, n };
  };

  const lookupFor =
    (configurations: () => Promise<Configurations>, signal?: AbortSignal): UpstreamLookup =>
    async (upstream, path, init) => {
      const request = new Request(`http://lookup.local${path.startsWith('/') ? path : `/${path}`}`, init);
      const { path: lookupPath, rawQuery } = splitTarget(path.startsWith('/') ? path : `/${path}`);
      const call = await preparedUpstreamCall(
        {
          upstream,
          configurations: (await configurations()) as Configurations<never>,
          method: request.method,
          path: lookupPath,
          rawQuery,
          headers: strippedCallerHeaders(request.headers),
          body: request.body,
          ...(signal === undefined ? {} : { signal }),
        },
        platform.upstreams.runsCredentials
      );
      return platform.upstreams.send(call);
    };

  const serviceConfiguration = async () => withSecrets(manifest.serviceForm, await platform.configurations.service());

  const service: ServiceHandle = {
    state: platform.state,
    webhookUrl: platform.webhookUrl ?? '',
    configuration: serviceConfiguration,
    async projectConfigurations() {
      const entries = await platform.configurations.projectConfigurations();
      return entries.map((entry) => ({
        ...entry,
        projectConfiguration: withSecrets(manifest.projectForm, entry.projectConfiguration),
      }));
    },
    async deliver(event, options) {
      const scope = requestScope.getStore();
      const results = await events.deliver(event, options.to, scope?.callerIdentity);
      for (const result of results) {
        if (scope && (result.result === 'stored' || result.result === 'duplicate')) {
          const counted = scope.delivered.get(event.type) ?? { stored: 0, duplicate: 0 };
          counted[result.result] += 1;
          scope.delivered.set(event.type, counted);
        }
        if (result.result === 'stored') {
          records.count({
            name: 'events',
            label: builtInCounters.events.label,
            description: builtInCounters.events.description ?? null,
            n: 1,
            projectId: null,
            projectEnvironmentId: result.projectEnvironmentId,
            environment: null,
          });
        } else if (result.result !== 'duplicate') {
          scope?.undelivered.push(result);
        }
      }
      return results;
    },
    count(name, n, options = {}) {
      records.count({
        ...declaredCounter(name, n),
        projectId: null,
        projectEnvironmentId: options.projectEnvironment ?? null,
        environment: null,
      });
    },
    [upstreamLookups]: lookupFor(async () => ({
      serviceConfiguration: await serviceConfiguration(),
      projectConfiguration: null,
    })),
  };

  const formHandlers = createFormHandlers(defined, {
    configurations: platform.configurations,
    state: platform.state,
    service,
    lookupFor: (configurations) => lookupFor(configurations),
    containsServiceSecret: (texts, values) => containsSecret(texts, secretValuesOf(manifest.serviceForm, values)),
  });

  const settingLabel = (key: string): string => {
    const field = fieldNamed(manifest.projectForm, key);
    return field && 'label' in field && field.label ? field.label : key;
  };

  const notAllowedRefusal = (message: string, setting: string | undefined, settingsLink: string | undefined) => {
    if (setting === undefined) return refusalOf('not allowed', sentence(message));
    const link = linkToField(settingsLink, setting);
    const named = `${sentence(message)} Setting "${settingLabel(setting)}"`;
    return refusalOf('not allowed', link === null ? `${named}.` : `${named}: ${link}`, { setting, link });
  };

  const run = async (
    call: IncomingCall,
    upgrade: boolean,
    recording: CallRecording
  ): Promise<Response | UpstreamCall> => {
    const { path, rawQuery } = splitTarget(call.target);
    const host = call.headers.get('host') ?? 'service.local';
    const plainRequest = () => {
      try {
        return new Request(`http://${host}${call.target}`, { method: call.method, headers: call.headers });
      } catch {
        return new Request(`http://${host}/`, { method: call.method });
      }
    };
    const refuse = (refusal: Refusal) => refusalResponse(refusal, plainRequest(), definition.refusal);

    const callerIdentity = call.headers.get(callerIdentityHeader) ?? '';
    const caller = verifyCallerIdentity(callerIdentity, platform.gatewayKey, now());
    if (!caller) {
      call.body?.cancel().catch(() => undefined);
      return refuse(refusalOf('unidentified', 'This request has no valid Caller identity.'));
    }

    recording.caller = caller;
    const scope = requestScope.getStore();
    if (scope) scope.callerIdentity = callerIdentity;
    const { notes } = recording;
    const settle = (outcome: CallOutcome, reason: string | null = null) => {
      recording.outcome = outcome;
      recording.reason = reason;
    };
    const refuseAndRecord = async (refusal: Refusal, reason: string = refusal.message) => {
      call.body?.cancel().catch(() => undefined);
      settle(refusal.outcome, reason);
      return refuse(refusal);
    };
    const failed = (failure: StepFailure) =>
      refuseAndRecord(refusalOf('failed', failureMessages[failure.kind](manifest.displayName)), failure.reason);
    const notSupported = (message: string) => refuseAndRecord(refusalOf('not supported', sentence(message)));

    const readConfiguration = async () => {
      try {
        return await platform.configurations.forCaller(caller, callerIdentity);
      } catch (error) {
        throw new StepFailure(`configuration fetch failed: ${errorText(error)}`);
      }
    };

    try {
      if (isWebhookPath(path)) {
        recording.route = 'webhook';
        if (upgrade || caller.kind !== 'platform') {
          return await notSupported('The Webhook address answers only the platform');
        }
        const webhook = definition.webhook;
        if (manifest.inbound !== true || webhook === undefined) {
          return await notSupported(`${manifest.displayName} has no Webhook address`);
        }
        let configured: FormValues;
        try {
          configured = await platform.configurations.service();
        } catch (error) {
          throw new StepFailure(`configuration fetch failed: ${errorText(error)}`);
        }
        const webhookConfigurations: Configurations = {
          serviceConfiguration: withSecrets(manifest.serviceForm, configured),
          projectConfiguration: null,
        };
        const providerHeaders = new Headers(call.headers);
        providerHeaders.delete(callerIdentityHeader);
        const carriesBody = call.body !== null && call.method !== 'GET' && call.method !== 'HEAD';
        if (!carriesBody) call.body?.cancel().catch(() => undefined);
        const below = path.slice(webhookPath.length) || '/';
        const request = new Request(`http://${host}${below}${rawQuery === '' ? '' : `?${rawQuery}`}`, {
          method: call.method,
          headers: providerHeaders,
          ...(carriesBody ? { body: call.body, duplex: 'half' } : {}),
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        } as RequestInit);
        const ctx: WebhookContext = {
          caller,
          serviceConfiguration: webhookConfigurations.serviceConfiguration,
          state: platform.state,
          service,
          note(fields) {
            Object.assign(notes, structuredClone(fields));
          },
          [upstreamLookups]: lookupFor(async () => webhookConfigurations, call.signal),
        };
        let answer: unknown;
        try {
          answer = await webhook(request, ctx);
        } catch (error) {
          return await failed(new StepFailure(`webhook threw: ${errorText(error)}`));
        }
        if (answer === undefined) {
          settle('handled');
          if ((scope?.undelivered.length ?? 0) === 0) return Response.json({ received: true });
          return Response.json(
            { message: 'Not every receiver took this Event yet; send it again.' },
            { status: 503, headers: { 'retry-after': String(eventCapRetryAfterSeconds) } }
          );
        }
        if (!(answer instanceof Response)) {
          return await failed(new StepFailure('webhook returned no Response'));
        }
        const bytes = new Uint8Array(await answer.arrayBuffer());
        const texts = [new TextDecoder().decode(bytes), ...[...answer.headers].map(([, value]) => value)];
        if (containsSecret(texts, secretValuesOf(manifest.serviceForm, configured))) {
          return await failed(new StepFailure('answer contained a secret', 'secretInAnswer'));
        }
        settle('handled', answer.status >= 400 ? `the webhook answered ${answer.status}` : null);
        return new Response(nullBodyStatuses.has(answer.status) ? null : bytes, {
          status: answer.status,
          statusText: answer.statusText,
          headers: answer.headers,
        });
      }

      const handlerPath = path.startsWith(`${wellKnownPath}/`) ? formHandlerPathOf(path) : null;
      if (handlerPath !== null && !upgrade) {
        recording.route = `${handlerPath.kind}.${handlerPath.name}`;
        if (caller.kind !== 'platform') {
          return formHandlers.stamped(await notSupported('Form calls and hooks answer only the platform'));
        }
        const answered = await formHandlers.answer({
          method: call.method,
          path: handlerPath,
          headers: call.headers,
          body: call.body,
          caller,
          callerIdentity,
          note: (fields) => Object.assign(notes, structuredClone(fields)),
        });
        if (answered.kind === 'refused') {
          return formHandlers.stamped(await refuseAndRecord(answered.refusal, answered.reason));
        }
        settle(answered.response.status < 400 ? 'handled' : 'failed');
        return answered.response;
      }

      if (path === wellKnownPath || path.startsWith(`${wellKnownPath}/`)) {
        recording.route = path;
        if (upgrade || call.method !== 'GET' || path !== wellKnownPath) {
          return await notSupported(`${call.method} ${path} is not supported by this service`);
        }
        call.body?.cancel().catch(() => undefined);
        const configuration = await readConfiguration().catch((error: unknown) => {
          notes.configuration = error instanceof StepFailure ? error.reason : errorText(error);
          return undefined;
        });
        settle('handled');
        return Response.json(describeService(defined, caller, configuration));
      }

      if (!isSafePath(path)) {
        return await notSupported(`${call.method} ${path} is not supported: the path has an unsafe segment`);
      }
      if (caller.kind !== 'call') {
        return await notSupported('Service routes answer only calls from a Project');
      }

      const configuration = await readConfiguration();
      if (configuration.projectConfiguration === null) {
        const link = configuration.settingsLink ?? null;
        const message = `This Project is not connected to ${manifest.displayName}.`;
        return await refuseAndRecord(
          refusalOf('not connected', link === null ? message : `${message} Connect it: ${link}`, { link })
        );
      }
      const missingProject = configuration.missing?.projectForm?.[0];
      if (missingProject !== undefined) {
        const link = linkToField(configuration.settingsLink, missingProject);
        const message = `This Project's ${manifest.displayName} configuration is missing "${settingLabel(missingProject)}"`;
        return await refuseAndRecord(
          refusalOf('incomplete', link === null ? `${message}.` : `${message}: ${link}`, {
            setting: missingProject,
            link,
          })
        );
      }
      const segments = decodedSegments(path);
      const matched = segments
        ? definition.routes
            .map((entry) => ({ entry, params: matchRoutePattern(entry.pattern, call.method, segments) }))
            .find((candidate) => candidate.params !== undefined)
        : undefined;
      if (!matched?.params) return await notSupported(`${call.method} ${path} is not supported by this service`);
      const { entry, params } = matched as { entry: Route; params: Record<string, string> };
      recording.route = entry.summary;

      if (entry.action === 'refuse') return await notSupported(entry.summary);
      if (upgrade && (entry.action === 'handle' || entry.through !== undefined)) {
        return await notSupported(`${entry.summary}: this route does not upgrade connections`);
      }

      const configurations: Configurations = {
        serviceConfiguration: withSecrets(manifest.serviceForm, configuration.serviceConfiguration),
        projectConfiguration: withSecrets(manifest.projectForm, configuration.projectConfiguration),
      };
      const ctx: RouteContext = {
        caller,
        params,
        projectConfiguration: configurations.projectConfiguration ?? {},
        serviceConfiguration: configurations.serviceConfiguration,
        missingServiceFields: [...(configuration.missing?.serviceForm ?? [])],
        state: platform.state,
        service,
        count(name, n = 1) {
          records.count({
            ...declaredCounter(name, n),
            projectId: caller.projectId ?? null,
            projectEnvironmentId: caller.projectEnvironmentId ?? null,
            environment: caller.environment ?? null,
          });
        },
        note(fields) {
          Object.assign(notes, structuredClone(fields));
        },
        allow: () => issueVerdict({ verdict: 'allow' }),
        notAllowed: ({ setting, message }) =>
          issueVerdict({ verdict: 'not allowed', message, ...(setting === undefined ? {} : { setting }) }),
        notSupported: (message) =>
          issueVerdict({ verdict: 'not supported', ...(message === undefined ? {} : { message }) }),
        [upstreamLookups]: lookupFor(async () => configurations, call.signal),
      };

      const limit = entry.bodyLimit ?? defaultBodyLimit;
      const body = new InboundBody(call.body, limit);
      const readerHeaders = new Headers(call.headers);
      readerHeaders.delete(callerIdentityHeader);
      const carriesBody = body.present && call.method !== 'GET' && call.method !== 'HEAD';
      const request = new Request(plainRequest().url, {
        method: call.method,
        headers: readerHeaders,
        ...(carriesBody ? { body: body.readerStream(call.headers), duplex: 'half' } : {}),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      } as RequestInit);

      const tooLarge = () =>
        refuseAndRecord(
          refusalOf('failed', `This request's body is larger than ${manifest.displayName} takes (${limit} bytes).`, {
            status: 413,
          }),
          `request body over ${limit} bytes`
        );
      const refusalForVerdict = (verdict: Verdict, step: string) => {
        if (verdict.verdict === 'not allowed') {
          return refuseAndRecord(notAllowedRefusal(verdict.message, verdict.setting, configuration.settingsLink));
        }
        if (verdict.verdict === 'not supported') {
          return notSupported(verdict.message ?? `${call.method} ${path} is not supported by this service`);
        }
        return failed(new StepFailure(`${step} answered allow instead of a Response`));
      };

      let verdict: unknown;
      try {
        verdict = await entry.check?.(request, ctx);
      } catch (error) {
        if (body.tooLarge || error instanceof BodyTooLarge) return await tooLarge();
        return await failed(new StepFailure(`check threw: ${errorText(error)}`));
      }
      if (body.tooLarge) return await tooLarge();
      if (!isVerdict(verdict)) {
        return await failed(
          new StepFailure('check returned no verdict (use ctx.allow, ctx.notAllowed or ctx.notSupported)')
        );
      }
      if (verdict.verdict !== 'allow') return await refusalForVerdict(verdict, 'the check');

      if (entry.handle) {
        let answer: unknown;
        try {
          answer = await entry.handle(request, ctx);
        } catch (error) {
          if (body.tooLarge || error instanceof BodyTooLarge) return await tooLarge();
          return await failed(new StepFailure(`handle threw: ${errorText(error)}`));
        }
        if (isVerdict(answer)) return await refusalForVerdict(answer, 'the handler');
        if (!(answer instanceof Response)) {
          return await failed(new StepFailure('handle returned no Response'));
        }
        const bytes = new Uint8Array(await answer.arrayBuffer());
        const texts = [new TextDecoder().decode(bytes), ...[...answer.headers].map(([, value]) => value)];
        if (containsSecret(texts, secretValuesOf(manifest.serviceForm, configuration.serviceConfiguration))) {
          return await failed(new StepFailure('answer contained a secret', 'secretInAnswer'));
        }
        call.body?.cancel().catch(() => undefined);
        settle('handled');
        return new Response(nullBodyStatuses.has(answer.status) ? null : bytes, {
          status: answer.status,
          statusText: answer.statusText,
          headers: answer.headers,
        });
      }

      const target = entry.to as Upstream<never>;
      const send = async (changed: Request | undefined, decode: boolean) => {
        const original = changed === undefined || changed === request;
        let forwardPath = path;
        let forwardQuery = rawQuery;
        let headers = call.headers;
        let forwardBody: UpstreamCall['body'] = await body.forwardable();
        if (!original) {
          const url = new URL(changed.url);
          forwardPath = url.pathname;
          forwardQuery = url.search.slice(1);
          headers = new Headers(changed.headers);
          forwardBody = changed.body;
          headers.delete('content-length');
          if (changed.body !== null) headers.delete('content-encoding');
          if (!isSafePath(forwardPath)) throw new StepFailure(`through asked for the unsafe path ${forwardPath}`);
        }
        let below: string;
        try {
          below = pathBelowMount(target, forwardPath);
        } catch (error) {
          throw new StepFailure(errorText(error));
        }
        const prepared = await preparedUpstreamCall(
          {
            upstream: target,
            configurations: configurations as Configurations<never>,
            method: original ? call.method : changed.method,
            path: below,
            rawQuery: forwardQuery,
            headers: strippedCallerHeaders(headers, { keepUpgrade: upgrade }),
            body: upgrade ? null : forwardBody,
            ...(call.signal === undefined ? {} : { signal: call.signal }),
          },
          platform.upstreams.runsCredentials
        );
        if (upgrade) return prepared;
        const answer = await platform.upstreams.send(prepared);
        return decode ? decodedResponse(answer) : answer;
      };

      if (upgrade) {
        const prepared = (await send(undefined, false)) as UpstreamCall;
        settle('proxied');
        return prepared;
      }

      if (!entry.through) {
        const answer = (await send(undefined, false)) as Response;
        settle('proxied');
        return answer;
      }

      let filtered: unknown;
      try {
        filtered = await entry.through(request, ctx, async (changed) => (await send(changed, true)) as Response);
      } catch (error) {
        if (error instanceof StepFailure) throw error;
        if (body.tooLarge || error instanceof BodyTooLarge) return await tooLarge();
        return await failed(new StepFailure(`through threw: ${errorText(error)}`));
      }
      if (isVerdict(filtered)) return await refusalForVerdict(filtered, 'through');
      if (!(filtered instanceof Response)) {
        return await failed(new StepFailure('through returned no Response'));
      }
      const headers = new Headers(filtered.headers);
      headers.delete('content-length');
      headers.delete('transfer-encoding');
      settle('proxied');
      return new Response(nullBodyStatuses.has(filtered.status) ? null : filtered.body, {
        status: filtered.status,
        statusText: filtered.statusText,
        headers,
      });
    } catch (error) {
      if (error instanceof StepFailure) return failed(error);
      return failed(new StepFailure(`upstream failed: ${errorText(error)}`, 'upstreamUnreachable'));
    }
  };

  const recordCall = (recording: CallRecording, status: number, bytesIn: number, bytesOut: number) => {
    const { caller } = recording;
    if (caller === undefined) return;
    records.call({
      requestId: recording.requestId,
      time: new Date(recording.startedAt).toISOString(),
      callerKind: caller.kind,
      projectId: caller.projectId ?? null,
      projectEnvironmentId: caller.projectEnvironmentId ?? null,
      environment: caller.environment ?? null,
      method: recording.method,
      path: recording.path,
      route: recording.route,
      outcome: callLogOutcomeOf[recording.outcome ?? 'handled'],
      reason: recording.reason,
      status,
      bytesIn,
      bytesOut,
      durationMs: now() - recording.startedAt,
      notes: recording.notes,
    });
  };

  const recorded = async (
    call: IncomingCall,
    upgrade: boolean
  ): Promise<{ answer: Response | UpstreamCall; recording: CallRecording; bytesIn: () => number }> => {
    const counted = call.body === null ? null : countedStream(call.body);
    const recording: CallRecording = {
      requestId: randomUUID(),
      startedAt: now(),
      method: call.method,
      path: splitTarget(call.target).path,
      notes: {},
      route: null,
      reason: null,
    };
    const declaredBytesIn = Number(call.headers.get('content-length') ?? 0);
    const bytesIn = () =>
      Math.max(
        counted?.bytes() ?? 0,
        Number.isSafeInteger(declaredBytesIn) && declaredBytesIn > 0 ? declaredBytesIn : 0
      );
    const scope: RequestScope = { undelivered: [], delivered: new Map() };
    try {
      const answer = await requestScope.run(scope, () =>
        run({ ...call, body: counted?.stream ?? null }, upgrade, recording)
      );
      if (scope.undelivered.length > 0) {
        recording.outcome = 'failed';
        recording.reason = undeliveredReason(scope.undelivered);
      } else {
        recording.reason ??= deliveredReason(scope.delivered);
      }
      return { answer, recording, bytesIn };
    } catch (error) {
      recording.outcome = 'failed';
      recording.reason = `the service could not answer: ${errorText(error)}`;
      recordCall(recording, refusalStatuses.failed, bytesIn(), 0);
      throw error;
    }
  };

  return {
    service,
    async answer(call) {
      const { answer, recording, bytesIn } = await recorded(call, false);
      const response = answer as Response;
      recording.outcome ??= outcomeOfAnswer(response);
      if (recording.caller === undefined) return response;
      if (response.body === null || nullBodyStatuses.has(response.status)) {
        recordCall(recording, response.status, bytesIn(), 0);
        return response;
      }
      const { stream } = countedStream(response.body, (bytesOut, problem) => {
        if (problem !== null && recording.reason === null) recording.reason = problem;
        recordCall(recording, response.status, bytesIn(), bytesOut);
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    async answerUpgrade(call) {
      const { answer, recording, bytesIn } = await recorded(call, true);
      if (answer instanceof Response) {
        recording.outcome ??= outcomeOfAnswer(answer);
        recordCall(recording, answer.status, bytesIn(), Number(answer.headers.get('content-length') ?? 0));
        return answer;
      }
      recordCall(recording, 101, bytesIn(), 0);
      return answer;
    },
  };
}
