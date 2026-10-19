import { z } from 'zod';

import type { CallerIdentity } from './caller-identity.ts';
import {
  defaultBodyLimit,
  upstreamLookups,
  type Configurations,
  type DefinedService,
  type FormHandlerContext,
  type FormName,
  type ServiceHandle,
  type UpstreamLookup,
} from './define-service.ts';
import { withSecrets, type FormValues } from './form-levels.ts';
import { failureMessages, refusalOf, type Refusal } from './refusals.ts';
import type { AtomicServiceState } from './service-state.ts';
import type { ConfigurationSource, RequestConfiguration } from './service-pipeline.ts';
import { wellKnownPath } from './well-known.ts';

export const manifestHeader = 'x-opsiforce-manifest';

export const expectedManifestHeader = 'x-opsiforce-expected-manifest';

export const reloadingRetryAfterSeconds = 2;

export const formCallTimeoutSeconds = 10;

export const maxOptionsPerCall = 50;

const messageLevel = z.enum(['info', 'success', 'warning', 'error']).optional();

export const formCallResultSchemas = {
  options: z.array(
    z.object({
      value: z.string().min(1).max(200),
      label: z.string().max(200),
      description: z.string().max(500).optional(),
    })
  ),
  info: z.object({ text: z.string().max(2000), level: messageLevel }),
  buttons: z.union([
    z.object({ message: z.string().max(2000), level: messageLevel }),
    z.object({
      image: z.object({ mimeType: z.string(), base64: z.base64() }),
      caption: z.string().max(500).optional(),
    }),
    z.object({ link: z.url({ protocol: /^https?$/ }), label: z.string().max(200).optional() }),
  ]),
} as const;

export const formHandlerKinds = ['options', 'info', 'buttons', 'hooks'] as const;

export type FormHandlerKind = (typeof formHandlerKinds)[number];

export const configurationHookNames = ['onServiceConfigurationSaved', 'onProjectConfigurationSaved'] as const;

type ConfigurationHookName = (typeof configurationHookNames)[number];

export interface FormHandlerPath {
  kind: FormHandlerKind;
  name: string;
}

export function formHandlerPathOf(path: string): FormHandlerPath | null {
  const [kind, name, ...rest] = path.slice(wellKnownPath.length + 1).split('/');
  if (rest.length > 0 || name === undefined || name === '') return null;
  if (!(formHandlerKinds as readonly string[]).includes(kind ?? '')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  return { kind: kind as FormHandlerKind, name: decoded };
}

export interface FormHandlerCall {
  method: string;
  path: FormHandlerPath;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  caller: CallerIdentity;
  callerIdentity: string;
  note(fields: Record<string, unknown>): void;
}

export type FormHandlerAnswer =
  | { kind: 'answered'; response: Response }
  | { kind: 'refused'; refusal: Refusal; reason?: string };

export interface FormHandlerPlatform {
  configurations: ConfigurationSource;
  state: AtomicServiceState;
  service: ServiceHandle;
  lookupFor(configurations: () => Promise<Configurations>): UpstreamLookup;
  containsServiceSecret(texts: readonly string[], serviceConfiguration: FormValues): boolean;
}

class FormHandlerRefusal extends Error {
  readonly refusal: Refusal;
  readonly reason: string;

  constructor(refusal: Refusal, reason: string = refusal.message) {
    super(refusal.message);
    this.refusal = refusal;
    this.reason = reason;
  }
}

function notSupported(reason: string): FormHandlerRefusal {
  return new FormHandlerRefusal(refusalOf('not supported', failureMessages.formOutOfDate()), reason);
}

function malformed(reason: string): FormHandlerRefusal {
  return new FormHandlerRefusal(refusalOf('failed', failureMessages.formOutOfDate()), reason);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function jsonBody(body: ReadableStream<Uint8Array> | null): Promise<Record<string, unknown>> {
  if (body === null) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > defaultBodyLimit) throw malformed(`form call body over ${defaultBodyLimit} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed('the form call body is not JSON');
  }
  if (!isPlainObject(parsed)) throw malformed('the form call body is not a JSON object');
  return parsed;
}

function stamped(response: Response, manifestHash: string): Response {
  const headers = new Headers(response.headers);
  headers.set(manifestHeader, manifestHash);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createFormHandlers(defined: DefinedService, platform: FormHandlerPlatform) {
  const { definition, manifest, manifestHash } = defined;

  const failed = (kind: 'failed' | 'secretInAnswer', reason: string) =>
    new FormHandlerRefusal(refusalOf('failed', failureMessages[kind](manifest.displayName)), reason);

  const contextOf = (call: FormHandlerCall, form: FormName, configurations: Configurations): FormHandlerContext => ({
    caller: call.caller,
    form,
    serviceConfiguration: configurations.serviceConfiguration,
    projectConfiguration: configurations.projectConfiguration,
    state: platform.state,
    service: platform.service,
    note: call.note,
    [upstreamLookups]: platform.lookupFor(async () => configurations),
  });

  const savedConfigurations = async (call: FormHandlerCall): Promise<RequestConfiguration> => {
    try {
      return await platform.configurations.forCaller(call.caller, call.callerIdentity);
    } catch (error) {
      throw failed('failed', `configuration fetch failed: ${errorText(error)}`);
    }
  };

  const opened = (configuration: RequestConfiguration): Configurations => ({
    serviceConfiguration: withSecrets(manifest.serviceForm, configuration.serviceConfiguration),
    projectConfiguration:
      configuration.projectConfiguration === null
        ? null
        : withSecrets(manifest.projectForm, configuration.projectConfiguration),
  });

  const run = async <Value>(step: string, handler: () => Value | Promise<Value>): Promise<Value> => {
    try {
      return await handler();
    } catch (error) {
      if (error instanceof FormHandlerRefusal) throw error;
      throw failed('failed', `${step} threw: ${errorText(error)}`);
    }
  };

  const answerHook = async (call: FormHandlerCall): Promise<Response> => {
    const name = call.path.name as ConfigurationHookName;
    if (!(configurationHookNames as readonly string[]).includes(name)) {
      throw notSupported(`no hook named "${call.path.name}"`);
    }
    const form: FormName = name === 'onServiceConfigurationSaved' ? 'serviceForm' : 'projectForm';
    if (form === 'projectForm' && call.caller.projectEnvironmentId === undefined) {
      throw notSupported(`${name} names no ProjectEnvironment`);
    }
    const body = await jsonBody(call.body);
    platform.configurations.forget?.(call.caller);
    const hook = definition.hooks?.[name];
    if (hook === undefined) return new Response(null, { status: 204 });
    const fields = manifest[form];
    const change = {
      previous: isPlainObject(body.previous) ? withSecrets(fields, body.previous) : null,
      current: isPlainObject(body.current) ? withSecrets(fields, body.current) : null,
    };
    const ctx = contextOf(call, form, opened(await savedConfigurations(call)));
    await run(name, () =>
      (hook as (change: unknown, ctx: FormHandlerContext) => unknown).call(definition.hooks, change, ctx)
    );
    return new Response(null, { status: 204 });
  };

  const answerFormCall = async (call: FormHandlerCall): Promise<Response> => {
    const { kind, name } = call.path as { kind: Exclude<FormHandlerKind, 'hooks'>; name: string };
    const handler = definition[kind]?.[name];
    if (handler === undefined) throw notSupported(`no ${kind} handler named "${name}"`);
    const body = await jsonBody(call.body);
    const form = body.form === 'serviceForm' || body.form === 'projectForm' ? body.form : null;
    if (form === null) throw malformed('form is neither serviceForm nor projectForm');
    if (form === 'projectForm' && call.caller.projectEnvironmentId === undefined) {
      throw notSupported('a Project-form call names no ProjectEnvironment');
    }
    const values = isPlainObject(body.values) ? body.values : {};
    let plainServiceConfiguration: FormValues;
    let configurations: Configurations;
    if (form === 'serviceForm') {
      plainServiceConfiguration = values;
      configurations = {
        serviceConfiguration: withSecrets(manifest.serviceForm, values),
        projectConfiguration: null,
      };
    } else {
      const saved = await savedConfigurations(call);
      plainServiceConfiguration = saved.serviceConfiguration;
      configurations = opened(saved);
    }
    const draft = {
      form,
      values: withSecrets(manifest[form], values),
      ...(kind === 'options' ? { query: typeof body.query === 'string' ? body.query : '' } : {}),
      ...(typeof body.item === 'string' ? { item: body.item } : {}),
    };
    const ctx = contextOf(call, form, configurations);
    const result = await run(`${kind}.${name}`, () =>
      (handler as (draft: unknown, ctx: FormHandlerContext) => unknown)(draft, ctx)
    );
    const text = result === undefined ? undefined : JSON.stringify(result);
    if (text === undefined) {
      throw failed('failed', `${kind}.${name} returned nothing`);
    }
    if (platform.containsServiceSecret([text], plainServiceConfiguration)) {
      throw failed('secretInAnswer', 'answer contained a secret');
    }
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };

  return {
    async answer(call: FormHandlerCall): Promise<FormHandlerAnswer> {
      try {
        const expected = call.headers.get(expectedManifestHeader);
        if (expected !== null && expected !== manifestHash) {
          call.body?.cancel().catch(() => undefined);
          return {
            kind: 'answered',
            response: stamped(
              Response.json(
                {
                  code: 'service-reloading',
                  message: `${manifest.displayName} is updating to a new version. Try again in a moment.`,
                },
                { status: 503, headers: { 'retry-after': String(reloadingRetryAfterSeconds) } }
              ),
              manifestHash
            ),
          };
        }
        if (call.method !== 'POST') throw notSupported(`${call.method} form call; form calls are POST`);
        const response = call.path.kind === 'hooks' ? await answerHook(call) : await answerFormCall(call);
        return { kind: 'answered', response: stamped(response, manifestHash) };
      } catch (error) {
        call.body?.cancel().catch(() => undefined);
        if (error instanceof FormHandlerRefusal)
          return { kind: 'refused', refusal: error.refusal, reason: error.reason };
        throw error;
      }
    },
    stamped: (response: Response) => stamped(response, manifestHash),
  };
}
