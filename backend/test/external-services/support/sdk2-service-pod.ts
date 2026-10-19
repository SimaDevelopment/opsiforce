import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowAll,
  defineService,
  route,
  Secret,
  type FormHandlerContext,
  type Route,
  type ServiceDefinition,
  type ServiceHandle,
  type WebhookHandler,
} from '@opsiforce/external-service-sdk';
import {
  createFileServiceRecords,
  createServiceHttpServer,
  type CallerIdentity,
} from '@opsiforce/external-service-sdk/server';

export const SDK2_BOARDS_MANIFEST = {
  sdk: 2,
  displayName: 'Fixture Boards',
  description: 'A pretend board tool the Organization built itself, on SDK 2.',
  serviceForm: [
    { key: 'apiToken', type: 'secret', label: 'API token', required: true },
    { key: 'region', type: 'text', label: 'Region' },
  ],
  projectForm: [
    {
      key: 'boardIds',
      type: 'multiselect',
      label: 'Boards',
      required: true,
      options: [
        { value: 'b1', label: 'Roadmap' },
        { value: 'b2', label: 'Operations' },
      ],
    },
    { key: 'signingSecret', type: 'secret', label: 'Signing secret' },
  ],
} as const;

export interface Sdk2PodRequest {
  method: string;
  path: string;
  caller: CallerIdentity;
  projectConfiguration: Record<string, unknown>;
  serviceConfiguration: Record<string, unknown>;
}

export interface Sdk2PodHook {
  hook: 'onServiceConfigurationSaved' | 'onProjectConfigurationSaved';
  previous: unknown;
  current: unknown;
  caller: CallerIdentity;
  serviceConfiguration: Record<string, unknown>;
  projectConfiguration: Record<string, unknown> | null;
}

export type Sdk2PodHandlers = Pick<ServiceDefinition, 'options' | 'info' | 'buttons' | 'hooks'>;

export interface Sdk2ServicePod {
  url: string;
  received: Sdk2PodRequest[];
  hooks: Sdk2PodHook[];
  service: ServiceHandle;
  flushRecords(): void;
  close(): Promise<void>;
}

export interface Sdk2ServicePodOptions {
  gatewayKey: string;
  gatewayUrl: string;
  port: number;
  manifest?: unknown;
  routes?: (received: Sdk2PodRequest[]) => Route[];
  counters?: ServiceDefinition['counters'];
  handlers?: Sdk2PodHandlers;
  hooksDeclared?: boolean;
  webhook?: WebhookHandler;
  stateFile?: string;
  recordsFile?: string;
}

export function revealed(value: unknown): unknown {
  if (value instanceof Secret) return value.reveal();
  if (Array.isArray(value)) return value.map(revealed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, revealed(entry)]));
  }
  return value;
}

function answeringEverything(received: Sdk2PodRequest[]): Route[] {
  return [
    route('* /**', {
      summary: 'Answers every request with what it saw',
      allowedBy: [],
      check: allowAll,
      handle: (request, ctx) => {
        const path = new URL(request.url).pathname;
        received.push({
          method: request.method,
          path,
          caller: ctx.caller,
          projectConfiguration: revealed(ctx.projectConfiguration) as Record<string, unknown>,
          serviceConfiguration: revealed(ctx.serviceConfiguration) as Record<string, unknown>,
        });
        return Response.json({ method: request.method, path });
      },
    }),
  ];
}

function recordingHooks(hooks: Sdk2PodHook[]): NonNullable<ServiceDefinition['hooks']> {
  const record =
    (hook: Sdk2PodHook['hook']) => (change: { previous: unknown; current: unknown }, ctx: FormHandlerContext) => {
      hooks.push({
        hook,
        previous: revealed(change.previous),
        current: revealed(change.current),
        caller: ctx.caller,
        serviceConfiguration: revealed(ctx.serviceConfiguration) as Record<string, unknown>,
        projectConfiguration: revealed(ctx.projectConfiguration) as Record<string, unknown> | null,
      });
    };
  return {
    onServiceConfigurationSaved: record('onServiceConfigurationSaved'),
    onProjectConfigurationSaved: record('onProjectConfigurationSaved'),
  };
}

export async function startSdk2ServicePod(options: Sdk2ServicePodOptions): Promise<Sdk2ServicePod> {
  const ownFolder = mkdtempSync(join(tmpdir(), 'sdk2-pod-'));
  const received: Sdk2PodRequest[] = [];
  const hooks: Sdk2PodHook[] = [];
  const defined = defineService({
    manifest: options.manifest ?? SDK2_BOARDS_MANIFEST,
    routes: (options.routes ?? answeringEverything)(received),
    ...(options.counters === undefined ? {} : { counters: options.counters }),
    ...(options.hooksDeclared === false ? {} : { hooks: recordingHooks(hooks) }),
    ...options.handlers,
    ...(options.webhook === undefined ? {} : { webhook: options.webhook }),
  });
  const records = createFileServiceRecords({
    file: options.recordsFile ?? join(ownFolder, 'service-records.db'),
  });
  const { server, service } = createServiceHttpServer(defined, {
    gatewayKey: options.gatewayKey,
    gatewayUrl: options.gatewayUrl,
    stateFile: options.stateFile ?? join(ownFolder, 'service-state.db'),
    records,
  });
  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    hooks,
    service,
    flushRecords: () => records.flush(),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      records.close();
      rmSync(ownFolder, { recursive: true, force: true });
    },
  };
}

export function environmentStateFile(storageRoot: string, directory: string): string {
  return join(storageRoot, directory, 'data', 'service-state.db');
}
