import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { Secret, type Caller, type ServiceState } from '@opsiforce/external-service-sdk';
import {
  computeManifestHash,
  createFileServiceState,
  createServiceServer,
  gatewayKeyHeader,
  type AnyServiceHandlers,
} from '@opsiforce/external-service-sdk/server';

export interface FakeServicePodOptions {
  manifest: unknown;
  gatewayKey: string;
  stateFile?: string;
  port?: number;
}

export interface FakeInboundRequest {
  method: string;
  headers: Record<string, string>;
  rawBody: Uint8Array;
  body: unknown;
}

export interface FakeInboundContext {
  callId: string;
  webhookUrl: string;
  serviceConfiguration: Record<string, unknown>;
  state: ServiceState;
}

export type FakeInbound = (request: FakeInboundRequest, ctx: FakeInboundContext) => unknown;

export interface ReceivedOperation {
  operation: string;
  input: Record<string, unknown>;
  callId: string;
  caller: Caller;
  webhookUrl: string;
  serviceConfiguration: Record<string, unknown>;
  projectConfiguration: Record<string, unknown>;
  platformApi: unknown;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  gatewayKey: string | undefined;
}

export interface FakeOperationContext {
  callId: string;
  caller: Caller;
  serviceConfiguration: Record<string, unknown>;
  projectConfiguration: Record<string, unknown>;
  platformApi?: unknown;
  state: ServiceState;
  signal: AbortSignal;
}

export type FakeOperation = (input: Record<string, unknown>, ctx: FakeOperationContext) => unknown;

export type FormCallRoute = 'options' | 'info' | 'buttons';

export interface ReceivedFormCall {
  route: FormCallRoute;
  name: string;
  callId: string;
  caller: Caller | undefined;
  form: string;
  query: string | undefined;
  values: Record<string, unknown>;
  serviceConfiguration: Record<string, unknown>;
}

export interface FakeFormCallRequest {
  values: Record<string, unknown>;
  query?: string;
}

export interface FakeFormCallContext {
  callId: string;
  serviceConfiguration: Record<string, unknown>;
  signal: AbortSignal;
}

export type FakeFormCall = (request: FakeFormCallRequest, ctx: FakeFormCallContext) => unknown;

export type HookName = 'onServiceConfigurationSaved' | 'onProjectConfigurationSaved';

export interface ReceivedHook {
  hook: HookName;
  callId: string;
  caller: Caller | undefined;
  previous: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  serviceConfiguration: Record<string, unknown>;
}

export interface FakeHookContext {
  callId: string;
  caller: Caller | undefined;
  serviceConfiguration: Record<string, unknown>;
  signal: AbortSignal;
}

export type FakeHook = (
  change: { previous: Record<string, unknown> | null; current: Record<string, unknown> | null },
  ctx: FakeHookContext
) => unknown;

export interface FakeServicePod {
  url: string;
  manifestHash: string;
  requests: ReceivedRequest[];
  received: ReceivedOperation[];
  receivedFormCalls: ReceivedFormCall[];
  receivedHooks: ReceivedHook[];
  logs: string[];
  state: ServiceState;
  scriptHook(hook: HookName, handler: FakeHook): void;
  scriptFormCall(route: FormCallRoute, name: string, handler: FakeFormCall): void;
  slowFormCall(route: FormCallRoute, name: string, delayMs: number): void;
  script(operation: string, handler: FakeOperation): void;
  crash(operation: string): void;
  slow(operation: string, delayMs: number): void;
  echoSecret(operation: string, pick: (serviceConfiguration: Record<string, unknown>) => unknown): void;
  scriptInbound(handler: FakeInbound): void;
  close(): Promise<void>;
}

type FormField = Record<string, unknown> & { type?: string };

function revealed(value: unknown): unknown {
  if (value instanceof Secret) return value.reveal();
  if (Array.isArray(value)) return value.map(revealed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, revealed(entry)]));
  }
  return value;
}

function formCallNames(fields: unknown, names: Record<'options' | 'info' | 'buttons', Set<string>>): void {
  if (!Array.isArray(fields)) return;
  for (const field of fields as FormField[]) {
    if (field.type === 'section') formCallNames(field.fields, names);
    if (field.type === 'list') formCallNames(field.item, names);
    const options = field.options as Record<string, unknown> | undefined;
    if (options && !Array.isArray(options) && typeof options.call === 'string') names.options.add(options.call);
    if (field.type === 'info' && typeof field.call === 'string') names.info.add(field.call);
    if (field.type === 'button' && typeof field.call === 'string') names.buttons.add(field.call);
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(ms, undefined, { signal });
  } catch {
    return;
  }
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function environmentStateFile(storageRoot: string, directory: string): string {
  return join(storageRoot, directory, 'data', 'service-state.db');
}

export async function startFakeServicePod(options: FakeServicePodOptions): Promise<FakeServicePod> {
  const ownStateFolder = options.stateFile === undefined ? mkdtempSync(join(tmpdir(), 'fake-pod-state-')) : null;
  const stateFile = options.stateFile ?? join(ownStateFolder ?? '', 'service-state.db');
  const manifest = options.manifest as Record<string, unknown>;
  const scripts = new Map<string, FakeOperation>();
  const received: ReceivedOperation[] = [];
  const receivedFormCalls: ReceivedFormCall[] = [];
  const formCallScripts = new Map<string, FakeFormCall>();
  const receivedHooks: ReceivedHook[] = [];
  const hookScripts = new Map<HookName, FakeHook>();
  const requests: ReceivedRequest[] = [];
  const logs: string[] = [];
  let inbound: FakeInbound = () => ({ events: [] });

  const formCalls = { options: new Set<string>(), info: new Set<string>(), buttons: new Set<string>() };
  formCallNames(manifest.serviceForm, formCalls);
  formCallNames(manifest.projectForm, formCalls);

  const operation =
    (name: string) =>
    (input: Record<string, unknown>, ctx: FakeOperationContext): unknown => {
      received.push({
        operation: name,
        input,
        callId: ctx.callId,
        caller: ctx.caller,
        webhookUrl: (ctx as FakeOperationContext & { webhookUrl: string }).webhookUrl,
        serviceConfiguration: revealed(ctx.serviceConfiguration) as Record<string, unknown>,
        projectConfiguration: revealed(ctx.projectConfiguration) as Record<string, unknown>,
        platformApi: ctx.platformApi,
      });
      const script = scripts.get(name);
      return script ? script(input, ctx) : { operation: name, input };
    };

  const formCall =
    (route: FormCallRoute, name: string, answer: unknown) =>
    (request: FakeFormCallRequest, ctx: FakeFormCallContext & { form: string; caller?: Caller }): unknown => {
      receivedFormCalls.push({
        route,
        name,
        callId: ctx.callId,
        caller: ctx.caller,
        form: ctx.form,
        query: request.query,
        values: revealed(request.values) as Record<string, unknown>,
        serviceConfiguration: revealed(ctx.serviceConfiguration) as Record<string, unknown>,
      });
      const script = formCallScripts.get(`${route}/${name}`);
      return script ? script(request, ctx) : answer;
    };

  const hook =
    (name: HookName) =>
    (change: Parameters<FakeHook>[0], ctx: FakeHookContext): unknown => {
      receivedHooks.push({
        hook: name,
        callId: ctx.callId,
        caller: ctx.caller,
        previous: revealed(change.previous) as Record<string, unknown> | null,
        current: revealed(change.current) as Record<string, unknown> | null,
        serviceConfiguration: revealed(ctx.serviceConfiguration) as Record<string, unknown>,
      });
      return hookScripts.get(name)?.(change, ctx);
    };

  const handlers = {
    manifestHash: computeManifestHash(manifest),
    operations: Object.fromEntries(Object.keys(manifest.operations ?? {}).map((name) => [name, operation(name)])),
    options: Object.fromEntries([...formCalls.options].map((name) => [name, formCall('options', name, [])])),
    info: Object.fromEntries([...formCalls.info].map((name) => [name, formCall('info', name, { text: name })])),
    buttons: Object.fromEntries(
      [...formCalls.buttons].map((name) => [name, formCall('buttons', name, { message: name })])
    ),
    hooks: {
      onServiceConfigurationSaved: hook('onServiceConfigurationSaved'),
      onProjectConfigurationSaved: hook('onProjectConfigurationSaved'),
    },
    ...(manifest.inbound === true
      ? {
          inbound: (request: FakeInboundRequest, ctx: FakeInboundContext) =>
            inbound(request, {
              ...ctx,
              serviceConfiguration: revealed(ctx.serviceConfiguration) as Record<string, unknown>,
            }),
        }
      : {}),
  } as unknown as AnyServiceHandlers;

  const { server, runtime } = createServiceServer({
    manifest,
    handlers,
    origin: 'custom',
    gatewayKey: options.gatewayKey,
    stateFile,
    log: (line) => logs.push(line),
  });
  server.prependListener('request', (request: IncomingMessage) => {
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      gatewayKey: headerOf(request, gatewayKeyHeader),
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    manifestHash: runtime.manifestHash,
    requests,
    received,
    receivedFormCalls,
    receivedHooks,
    logs,
    state: createFileServiceState(stateFile),
    scriptHook: (name, handler) => hookScripts.set(name, handler),
    scriptFormCall: (route, name, handler) => formCallScripts.set(`${route}/${name}`, handler),
    slowFormCall: (route, name, delayMs) =>
      formCallScripts.set(`${route}/${name}`, async (_request, ctx) => {
        await delay(delayMs, ctx.signal);
        return route === 'options' ? [] : route === 'info' ? { text: name } : { message: name };
      }),
    script: (name, handler) => scripts.set(name, handler),
    crash: (name) =>
      scripts.set(name, () => {
        throw new Error('the fake service pod crashed on purpose');
      }),
    slow: (name, delayMs) =>
      scripts.set(name, async (input, ctx) => {
        await delay(delayMs, ctx.signal);
        return { operation: name, input };
      }),
    echoSecret: (name, pick) =>
      scripts.set(name, (_input, ctx) => ({ echoed: revealed(pick(ctx.serviceConfiguration)) })),
    scriptInbound: (handler) => {
      inbound = handler;
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      if (ownStateFolder) rmSync(ownStateFolder, { recursive: true, force: true });
    },
  };
}
