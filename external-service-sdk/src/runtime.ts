import { z } from 'zod';

import { createBoundsChecker, OutOfBoundsError } from './bounds.ts';
import { checkServiceManifest, type ServiceOrigin } from './check-manifest.ts';
import type { Field } from './fields.ts';
import {
  eachKeyedField,
  reservedProjectConfigurationKeys,
  withoutKeys,
  withSecrets,
  type FormValues,
  type KeyedField,
} from './form-levels.ts';
import {
  fileResultMarker,
  hookNames,
  type AnyHandler,
  type AnyServiceHandlers,
  type Caller,
  type FileOptions,
  type FileResult,
  type FormName,
  type HookName,
  type LogFields,
  type ServiceLog,
  type ServiceState,
} from './handlers.ts';
import { handlerTimeoutSeconds } from './handler-limits.ts';
import { computeManifestHash } from './manifest-hash.ts';
import { sdkVersion, type ServiceManifest } from './manifest.ts';
import { sdkPackageVersion } from './package-version.ts';
import { problem, problemMediaType, ServiceError, serviceErrorStatuses, type ProblemDetails } from './problems.ts';
import { Secret } from './secret.ts';
import { unavailableServiceState } from './service-state.ts';

export const serviceRoutes = ['operations', 'options', 'info', 'buttons', 'hooks', 'inbound'] as const;

export type ServiceRoute = (typeof serviceRoutes)[number];

export const manifestHeader = 'x-opsiforce-manifest';

export const expectedManifestHeader = 'x-opsiforce-expected-manifest';

export const reloadingRetryAfterSeconds = 2;

export { formCallTimeoutSeconds } from './handler-limits.ts';
export const maxOptionsPerCall = 50;

export interface ServiceResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface DispatchRequest {
  route: ServiceRoute;
  name?: string;
  body: unknown;
  signal?: AbortSignal;
  expectedManifestHash?: string;
}

export interface HandlerNames {
  operations: string[];
  options: string[];
  info: string[];
  buttons: string[];
  hooks: string[];
  inbound: boolean;
}

export interface ServiceHealth {
  sdk: number;
  sdkVersion: string;
  manifestHash: string;
  handlers: HandlerNames;
}

export interface ServiceRuntimeOptions {
  manifest: unknown;
  handlers: AnyServiceHandlers;
  origin?: ServiceOrigin;
  log?: (line: string) => void;
  state?: (call: { callId: string }) => ServiceState;
}

export interface ServiceRuntime {
  readonly manifest: ServiceManifest;
  readonly manifestHash: string;
  health(): ServiceHealth;
  dispatch(request: DispatchRequest): Promise<ServiceResponse>;
}

export class ServiceBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceBootError';
  }
}

const callerSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  environment: z.string().min(1),
  via: z.string().min(1).max(100),
});

const configurationSchema = z.record(z.string(), z.unknown());

export const wireContextSchema = z.object({
  callId: z.string().min(1).max(200),
  caller: callerSchema.optional(),
  serviceConfiguration: configurationSchema.default({}),
  projectConfiguration: configurationSchema.optional(),
  webhookUrl: z.string().default(''),
  platformApi: z.object({ url: z.string().min(1).max(500), token: z.string().min(1).max(500) }).optional(),
});

export type WireContext = z.input<typeof wireContextSchema>;

const formName = z.enum(['serviceForm', 'projectForm']);

const operationBody = z.object({ context: wireContextSchema, input: z.unknown().default({}) });
const optionsBody = z.object({
  context: wireContextSchema,
  form: formName.optional(),
  query: z.string().max(500).default(''),
  values: configurationSchema.default({}),
});
const formCallBody = z.object({
  context: wireContextSchema,
  form: formName.optional(),
  values: configurationSchema.default({}),
});
const hookBody = z.object({
  context: wireContextSchema,
  previous: configurationSchema.nullable().default(null),
  current: configurationSchema.nullable().default(null),
});
const inboundBody = z.object({
  context: wireContextSchema,
  request: z.object({
    method: z.string().min(1).max(16),
    headers: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
    rawBody: z.base64().default(''),
    body: z.unknown().optional(),
    files: z
      .array(
        z.object({
          field: z.string().optional(),
          filename: z.string(),
          mimeType: z.string(),
          base64: z.base64(),
        })
      )
      .default([]),
  }),
});

const bytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'expected bytes (Uint8Array)');
const messageLevel = z.enum(['info', 'success', 'warning', 'error']).optional();

const optionsResult = z.array(
  z.object({
    value: z.string().min(1).max(200),
    label: z.string().max(200),
    description: z.string().max(500).optional(),
  })
);
const infoResult = z.object({ text: z.string().max(2000), level: messageLevel });
const buttonResult = z.union([
  z.object({ message: z.string().max(2000), level: messageLevel }),
  z.object({ image: z.object({ mimeType: z.string(), base64: z.base64() }), caption: z.string().max(500).optional() }),
  z.object({ link: z.url({ protocol: /^https?$/ }), label: z.string().max(200).optional() }),
]);
export const formCallResultSchemas = { options: optionsResult, info: infoResult, buttons: buttonResult } as const;

const inboundResult = z.object({
  events: z.array(
    z.object({
      type: z.string().min(1).max(100),
      key: z.string().min(1).max(500),
      occurredAt: z.string().min(1).max(64),
      data: z.record(z.string(), z.unknown()),
      files: z
        .array(z.object({ name: z.string().min(1).max(255), mimeType: z.string(), bytes: bytesSchema }))
        .optional(),
    })
  ),
  response: z
    .object({
      status: z.int().min(200).max(599).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.unknown().optional(),
    })
    .optional(),
});

const inboundErrorStatuses = [...serviceErrorStatuses, 401];

const encoder = new TextEncoder();

function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sortedKeys(record: object | undefined): string[] {
  return Object.keys(record ?? {}).toSorted();
}

export type FormCallRoute = 'options' | 'info' | 'buttons';

function formCallOf(field: KeyedField): { route: FormCallRoute; name: string } | undefined {
  if ('options' in field && !Array.isArray(field.options) && 'call' in field.options) {
    return { route: 'options', name: field.options.call };
  }
  if (field.type === 'info' && field.call !== undefined) return { route: 'info', name: field.call };
  if (field.type === 'button') return { route: 'buttons', name: field.call };
  return undefined;
}

export function declaredHandlerNames(manifest: ServiceManifest): HandlerNames {
  const calls: Record<FormCallRoute, Set<string>> = { options: new Set(), info: new Set(), buttons: new Set() };
  for (const form of [manifest.serviceForm, manifest.projectForm]) {
    eachKeyedField(form, (field) => {
      const call = formCallOf(field);
      if (call) calls[call.route].add(call.name);
    });
  }
  return {
    operations: sortedKeys(manifest.operations),
    options: [...calls.options].toSorted(),
    info: [...calls.info].toSorted(),
    buttons: [...calls.buttons].toSorted(),
    hooks: [],
    inbound: manifest.inbound === true,
  };
}

export function formReferencing(manifest: ServiceManifest, route: FormCallRoute, name: string): FormName {
  let found: FormName = 'serviceForm';
  eachKeyedField(manifest.projectForm, (field) => {
    const call = formCallOf(field);
    if (call?.route === route && call.name === name) found = 'projectForm';
  });
  return found;
}

function checkHandlers(declared: HandlerNames, handlers: AnyServiceHandlers): void {
  const missing: string[] = [];
  const undeclared: string[] = [];
  for (const group of ['operations', 'options', 'info', 'buttons'] as const) {
    const provided = handlers[group] ?? {};
    for (const name of declared[group]) {
      if (typeof provided[name] !== 'function') missing.push(`${group}.${name}`);
    }
    for (const name of Object.keys(provided)) {
      if (!declared[group].includes(name)) undeclared.push(`${group}.${name}`);
    }
  }
  if (declared.inbound && typeof handlers.inbound !== 'function') missing.push('inbound');
  if (!declared.inbound && handlers.inbound !== undefined) undeclared.push('inbound');
  for (const name of Object.keys(handlers.hooks ?? {})) {
    if (!(hookNames as readonly string[]).includes(name)) undeclared.push(`hooks.${name}`);
  }

  const problems = [
    ...(missing.length > 0 ? [`missing handlers: ${missing.join(', ')}`] : []),
    ...undeclared.map((name) => `${name} is not declared in service.json`),
  ];
  if (problems.length > 0) {
    throw new ServiceBootError(`The service cannot start: ${problems.join('; ')}`);
  }
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): ServiceResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: encoder.encode(JSON.stringify(value ?? null)),
  };
}

function problemResponse(body: ProblemDetails, headers: Record<string, string> = {}): ServiceResponse {
  return {
    status: body.status,
    headers: { 'content-type': problemMediaType, ...headers },
    body: encoder.encode(JSON.stringify(body)),
  };
}

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'the request is malformed';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function isFileResult(value: unknown): value is FileResult {
  return typeof value === 'object' && value !== null && fileResultMarker in value;
}

function file(bytes: Uint8Array | string, options: FileOptions): FileResult {
  return {
    [fileResultMarker]: true,
    bytes: typeof bytes === 'string' ? encoder.encode(bytes) : bytes,
    mimeType: options.mimeType,
    ...(options.filename === undefined ? {} : { filename: options.filename }),
  };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function parseInboundBody(rawBody: Uint8Array, headers: Record<string, string>): unknown {
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const text = new TextDecoder().decode(rawBody);
  if (/\bjson\b/i.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return undefined;
}

class HandlerTimeout extends Error {
  readonly seconds: number;

  constructor(seconds: number) {
    super(`the handler did not finish within ${seconds} s`);
    this.seconds = seconds;
  }
}

export function createServiceRuntime(options: ServiceRuntimeOptions): ServiceRuntime {
  const check = checkServiceManifest(options.manifest, { origin: options.origin ?? 'custom' });
  if (!check.ok || !check.manifest) {
    const errors = check.problems
      .filter((entry) => entry.severity === 'error')
      .map((entry) => `${entry.path === '' ? 'service.json' : entry.path}: ${entry.message}`);
    throw new ServiceBootError(`service.json is invalid:\n${errors.join('\n')}`);
  }
  const manifest = check.manifest;
  const manifestHash = computeManifestHash(options.manifest);
  const { handlers } = options;
  if (handlers.manifestHash !== manifestHash) {
    throw new ServiceBootError(
      `service.types.ts is stale: it was generated for manifest ${handlers.manifestHash}, but service.json is now ${manifestHash}. Run external-service-cli types and restart.`
    );
  }
  const declared = declaredHandlerNames(manifest);
  checkHandlers(declared, handlers);

  const writeLog = options.log ?? defaultLog;
  const stateFor =
    options.state ??
    (() => unavailableServiceState('ctx.state is not available: this runtime was started without a state store'));
  const stamp = { [manifestHeader]: manifestHash };

  const health: ServiceHealth = {
    sdk: sdkVersion,
    sdkVersion: sdkPackageVersion,
    manifestHash,
    handlers: { ...declared, hooks: sortedKeys(handlers.hooks).filter((name) => handlers.hooks?.[name as HookName]) },
  };

  const loggerFor = (callId: string, route: ServiceRoute, name: string | undefined): ServiceLog => {
    const write =
      (level: string) =>
      (message: string, fields: LogFields = {}) =>
        writeLog(
          JSON.stringify({
            ...fields,
            time: new Date().toISOString(),
            level,
            callId,
            handler: name === undefined ? route : `${route}.${name}`,
            message,
          })
        );
    return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
  };

  const errorResponse = (error: unknown, route: ServiceRoute, callId: string, log: ServiceLog): ServiceResponse => {
    if (error instanceof OutOfBoundsError) return problemResponse({ ...error.toProblem(), callId });
    if (error instanceof ServiceError) {
      const allowed: readonly number[] = route === 'inbound' ? inboundErrorStatuses : serviceErrorStatuses;
      const body = { ...error.toProblem(), callId };
      if (!allowed.includes(body.status)) body.status = 502;
      const retryAfter: Record<string, string> =
        error.retryAfterSeconds === undefined ? {} : { 'retry-after': String(Math.ceil(error.retryAfterSeconds)) };
      return problemResponse(body, retryAfter);
    }
    if (error instanceof HandlerTimeout) {
      log.error('handler timed out', { seconds: error.seconds });
      return problemResponse(
        problem({
          status: 502,
          code: 'timeout',
          detail: `The service did not answer within ${error.seconds} s.`,
          callId,
        })
      );
    }
    log.error('handler failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return problemResponse(
      problem({
        status: 502,
        code: 'service-failed',
        title: 'Service failed',
        detail: 'The service failed while handling this call.',
        callId,
      })
    );
  };

  const invalidResult = (detail: string, callId: string, log: ServiceLog): ServiceResponse => {
    log.error('handler returned an invalid result', { detail });
    return problemResponse(problem({ status: 502, code: 'service-failed', title: 'Service failed', detail, callId }));
  };

  const run = async (
    handler: AnyHandler,
    request: unknown,
    ctx: object,
    timeoutSeconds: number,
    signal: AbortSignal
  ): Promise<unknown> => {
    if (signal.aborted) throw new HandlerTimeout(timeoutSeconds);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new HandlerTimeout(timeoutSeconds));
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => (handler as (request: unknown, ctx: object) => unknown)(request, ctx))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  const baseContext = (
    context: z.output<typeof wireContextSchema>,
    route: ServiceRoute,
    name: string | undefined,
    signal: AbortSignal
  ) => ({
    serviceConfiguration: withSecrets(manifest.serviceForm, context.serviceConfiguration),
    callId: context.callId,
    signal,
    webhookUrl: context.webhookUrl,
    log: loggerFor(context.callId, route, name),
    state: stateFor({ callId: context.callId }),
  });

  const projectValues = (values: FormValues | null | undefined, keep: readonly string[] = []): FormValues | null => {
    if (values === null || values === undefined) return null;
    const stripped = withoutKeys(
      values,
      reservedProjectConfigurationKeys.filter((key) => !keep.includes(key))
    );
    return withSecrets(manifest.projectForm, stripped);
  };

  const dispatchParsed = async (
    route: ServiceRoute,
    name: string | undefined,
    body: unknown,
    signalFrom: (timeoutSeconds: number) => AbortSignal
  ): Promise<ServiceResponse> => {
    const parse = <Schema extends z.ZodType>(schema: Schema) => schema.safeParse(body);
    const unknownHandler = () =>
      problemResponse(
        problem({
          status: 404,
          code: 'unknown-handler',
          detail: `This service has no ${route} handler named "${name ?? ''}".`,
        })
      );
    const invalidRequest = (error: z.ZodError) =>
      problemResponse(problem({ status: 400, code: 'invalid-request', detail: describeZodError(error) }));

    if (route === 'operations') {
      const handler = name === undefined ? undefined : handlers.operations?.[name];
      const operation = name === undefined ? undefined : manifest.operations?.[name];
      if (!handler || !operation || name === undefined) return unknownHandler();
      const parsed = parse(operationBody);
      if (!parsed.success) return invalidRequest(parsed.error);
      const { context, input } = parsed.data;
      if (!context.caller) {
        return problemResponse(
          problem({ status: 400, code: 'invalid-request', detail: 'context.caller is required for an Operation' })
        );
      }
      const timeoutSeconds = handlerTimeoutSeconds(manifest, route, name);
      const signal = signalFrom(timeoutSeconds);
      const base = baseContext(context, route, name, signal);
      const rawProject = context.projectConfiguration ?? {};
      const ctx = {
        ...base,
        operation: name,
        caller: context.caller satisfies Caller,
        platformApi: context.platformApi && {
          url: context.platformApi.url,
          token: new Secret(context.platformApi.token),
        },
        projectConfiguration: projectValues(rawProject) ?? {},
        bounds: createBoundsChecker({
          manifest,
          projectConfiguration: rawProject,
          serviceConfiguration: context.serviceConfiguration,
          operation: name,
        }),
        file,
      };
      try {
        const result = await run(handler, input, ctx, timeoutSeconds, signal);
        if (isFileResult(result)) {
          return {
            status: 200,
            headers: {
              'content-type': result.mimeType,
              ...(result.filename === undefined
                ? {}
                : { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}` }),
            },
            body: result.bytes,
          };
        }
        return jsonResponse(200, result);
      } catch (error) {
        return errorResponse(error, route, context.callId, base.log);
      }
    }

    if (route === 'options' || route === 'info' || route === 'buttons') {
      const handler = name === undefined ? undefined : handlers[route]?.[name];
      if (!handler || name === undefined) return unknownHandler();
      const parsed = route === 'options' ? parse(optionsBody) : parse(formCallBody);
      if (!parsed.success) return invalidRequest(parsed.error);
      const { context, values } = parsed.data;
      const form = parsed.data.form ?? formReferencing(manifest, route, name);
      const timeoutSeconds = handlerTimeoutSeconds(manifest, route, name);
      const signal = signalFrom(timeoutSeconds);
      const base = baseContext(context, route, name, signal);
      const ctx = { ...base, form, caller: context.caller };
      const formFields: Field[] | undefined = manifest[form];
      const request = {
        values: withSecrets(formFields, values),
        ...(route === 'options' ? { query: (parsed.data as z.output<typeof optionsBody>).query } : {}),
      };
      try {
        const result = await run(handler, request, ctx, timeoutSeconds, signal);
        const schema = route === 'options' ? optionsResult : route === 'info' ? infoResult : buttonResult;
        const checked = schema.safeParse(result);
        if (!checked.success) {
          return invalidResult(
            `${route}.${name} returned ${describeZodError(checked.error)}`,
            context.callId,
            base.log
          );
        }
        const value = route === 'options' ? (checked.data as unknown[]).slice(0, maxOptionsPerCall) : checked.data;
        return jsonResponse(200, value);
      } catch (error) {
        return errorResponse(error, route, context.callId, base.log);
      }
    }

    if (route === 'hooks') {
      const hookName = name as HookName | undefined;
      const handler = hookName === undefined ? undefined : handlers.hooks?.[hookName];
      if (!handler || hookName === undefined || !hookNames.includes(hookName)) return unknownHandler();
      const parsed = parse(hookBody);
      if (!parsed.success) return invalidRequest(parsed.error);
      const { context, previous, current } = parsed.data;
      const timeoutSeconds = handlerTimeoutSeconds(manifest, route, name);
      const signal = signalFrom(timeoutSeconds);
      const base = baseContext(context, route, name, signal);
      const ctx = { ...base, caller: context.caller };
      const change =
        hookName === 'onServiceConfigurationSaved'
          ? {
              previous: previous === null ? null : withSecrets(manifest.serviceForm, previous),
              current: current === null ? null : withSecrets(manifest.serviceForm, current),
            }
          : { previous: projectValues(previous, ['receive']), current: projectValues(current, ['receive']) };
      try {
        await run(handler, change, ctx, timeoutSeconds, signal);
        return { status: 204, headers: {}, body: new Uint8Array() };
      } catch (error) {
        return errorResponse(error, route, context.callId, base.log);
      }
    }

    const handler = handlers.inbound;
    if (!handler || !manifest.inbound) return unknownHandler();
    const parsed = parse(inboundBody);
    if (!parsed.success) return invalidRequest(parsed.error);
    const { context, request } = parsed.data;
    const timeoutSeconds = handlerTimeoutSeconds(manifest, route);
    const signal = signalFrom(timeoutSeconds);
    const base = baseContext(context, route, name, signal);
    const rawBody = new Uint8Array(Buffer.from(request.rawBody, 'base64'));
    const inboundRequest = {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value])),
      query: request.query,
      rawBody,
      body: request.body === undefined ? parseInboundBody(rawBody, request.headers) : request.body,
      files: request.files.map(({ base64: encoded, ...described }) =>
        Object.assign(described, { bytes: new Uint8Array(Buffer.from(encoded, 'base64')) })
      ),
    };
    try {
      const result = await run(handler, inboundRequest, base, timeoutSeconds, signal);
      const checked = inboundResult.safeParse(result);
      if (!checked.success) {
        return invalidResult(`inbound returned ${describeZodError(checked.error)}`, context.callId, base.log);
      }
      return jsonResponse(200, {
        events: checked.data.events.map((event) => ({
          ...event,
          ...(event.files === undefined
            ? {}
            : {
                files: event.files.map((entry) => ({
                  name: entry.name,
                  mimeType: entry.mimeType,
                  base64: base64(entry.bytes),
                })),
              }),
        })),
        ...(checked.data.response === undefined ? {} : { response: checked.data.response }),
      });
    } catch (error) {
      return errorResponse(error, route, context.callId, base.log);
    }
  };

  return {
    manifest,
    manifestHash,
    health: () => structuredClone(health),
    async dispatch(request) {
      const signalFrom = (timeoutSeconds: number) =>
        request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutSeconds * 1000)])
          : AbortSignal.timeout(timeoutSeconds * 1000);
      const expectsOtherManifest =
        request.expectedManifestHash !== undefined && request.expectedManifestHash !== manifestHash;
      const response = expectsOtherManifest
        ? problemResponse(
            problem({
              status: 503,
              code: 'service-reloading',
              detail: 'The service is running another version of its manifest; retry shortly.',
            }),
            { 'retry-after': String(reloadingRetryAfterSeconds) }
          )
        : (serviceRoutes as readonly string[]).includes(request.route)
          ? await dispatchParsed(request.route, request.name, request.body, signalFrom)
          : problemResponse(problem({ status: 404, code: 'unknown-route', detail: `No route ${request.route}.` }));
      return { ...response, headers: { ...response.headers, ...stamp } };
    },
  };
}
