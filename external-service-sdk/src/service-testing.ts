import { callerIdentityHeader, mintCallerIdentity, type CallerIdentity } from './caller-identity.ts';
import type {
  DefinedService,
  DeliveryResult,
  DeliveryResultKind,
  ProjectConfigurationEntry,
  DeliveredEvent,
  ServiceHandle,
} from './define-service.ts';
import type { Field } from './fields.ts';
import type { FormValues } from './form-levels.ts';
import { missingRequiredFieldKeys } from './form-values.ts';
import { createServicePipeline, webhookPath, type ConfigurationSource } from './service-pipeline.ts';
import { createMemoryServiceState, withAtomicUpdate } from './service-state.ts';
import type { UpstreamCall, UpstreamTransport } from './upstream-forwarding.ts';
import { wellKnownPath } from './well-known.ts';

export type UpstreamFake = (request: Request) => Response | Promise<Response>;

export interface ServiceTestOptions {
  serviceConfiguration?: FormValues;
  projectConfiguration?: FormValues;
  projectConfigurations?: ProjectConfigurationEntry[];
  caller?: Partial<CallerIdentity>;
  upstreams?: Record<string, UpstreamFake>;
  deliveryResults?: Record<string, DeliveryResultKind>;
}

export interface TestDelivery {
  event: DeliveredEvent;
  to: readonly string[];
}

export interface ServiceTestKit {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly service: ServiceHandle;
  readonly deliveries: readonly TestDelivery[];
}

export const testGatewayKey = 'gw-test-service-pod-key';

export const testServiceHost = 'service.test';

export const testServiceCaller = {
  tenantId: 'tenant_test',
  projectId: 'project_test',
  projectEnvironmentId: 'pe_test',
  environment: 'development',
} as const;

export const testSettingsBase = 'https://opsiforce.test/projects';

export const testServiceWebhookUrl = 'https://opsiforce.test/api/external-services/webhooks/test/development';

export interface StaticConfigurationOptions {
  manifest: { serviceForm?: readonly Field[]; projectForm?: readonly Field[] };
  serviceConfiguration?: FormValues;
  projectConfiguration?: FormValues;
  projectConfigurations?: ProjectConfigurationEntry[];
  slug?: string;
}

export function staticConfigurations(options: StaticConfigurationOptions): ConfigurationSource {
  const serviceConfiguration = options.serviceConfiguration ?? {};
  const slug = options.slug ?? 'service';
  return {
    async forCaller(caller) {
      const projectConfiguration =
        caller.projectEnvironmentId === undefined ? null : (options.projectConfiguration ?? null);
      return {
        serviceConfiguration,
        projectConfiguration,
        missing: {
          serviceForm: missingRequiredFieldKeys(options.manifest.serviceForm ?? [], serviceConfiguration),
          projectForm:
            projectConfiguration === null
              ? []
              : missingRequiredFieldKeys(options.manifest.projectForm ?? [], projectConfiguration),
        },
        ...(caller.projectId === undefined
          ? {}
          : { settingsLink: `${testSettingsBase}/${caller.projectId}?configure=${slug}` }),
      };
    },
    service: async () => serviceConfiguration,
    projectConfigurations: async () => options.projectConfigurations ?? [],
  };
}

function fakeUpstreams(fakes: Record<string, UpstreamFake>): UpstreamTransport {
  return {
    runsCredentials: false,
    async send(call: UpstreamCall) {
      const fake = fakes[call.upstream.name];
      if (!fake) throw new Error(`upstream ${call.upstream.name} is not faked in this test`);
      const carriesBody = call.body !== null && call.method !== 'GET' && call.method !== 'HEAD';
      const request = new Request(`${call.origin}${call.target}`, {
        method: call.method,
        headers: call.headers,
        ...(carriesBody ? { body: call.body, duplex: 'half' } : {}),
      } as RequestInit);
      const answer = await fake(request);
      if (!(answer instanceof Response))
        throw new Error(`the fake for upstream ${call.upstream.name} gave no Response`);
      return answer;
    },
  };
}

function targetOf(input: string | URL | Request): string {
  if (typeof input === 'string' && input.startsWith('/')) return input;
  const url = new URL(input instanceof Request ? input.url : input);
  return `${url.pathname}${url.search}`;
}

export function testDefinedService(defined: DefinedService, options: ServiceTestOptions = {}): ServiceTestKit {
  const deliveries: TestDelivery[] = [];
  const caller = { ...testServiceCaller, ...options.caller };
  const pipeline = createServicePipeline(defined, {
    gatewayKey: testGatewayKey,
    configurations: staticConfigurations({ ...options, manifest: defined.manifest }),
    upstreams: fakeUpstreams(options.upstreams ?? {}),
    state: withAtomicUpdate(createMemoryServiceState()),
    webhookUrl: testServiceWebhookUrl,
    events: {
      async deliver(event, to): Promise<DeliveryResult[]> {
        deliveries.push({ event, to });
        return to.map((projectEnvironmentId) => ({
          projectEnvironmentId,
          result: options.deliveryResults?.[projectEnvironmentId] ?? 'stored',
        }));
      },
    },
  });

  return {
    service: pipeline.service,
    deliveries,
    async fetch(input, init) {
      const target = targetOf(input);
      const request = new Request(
        typeof input === 'string' && input.startsWith('/') ? `http://${testServiceHost}/` : input,
        init
      );
      const headers = new Headers(request.headers);
      if (!headers.has('host')) headers.set('host', testServiceHost);
      if (!headers.has(callerIdentityHeader)) {
        const path = target.split('?')[0] ?? target;
        const identity =
          path === webhookPath || path.startsWith(`${webhookPath}/`)
            ? { kind: 'platform' as const, tenantId: caller.tenantId }
            : { ...caller, kind: target.startsWith(`${wellKnownPath}/`) ? ('platform' as const) : ('call' as const) };
        headers.set(callerIdentityHeader, mintCallerIdentity(identity, testGatewayKey));
      } else if (headers.get(callerIdentityHeader) === '') {
        headers.delete(callerIdentityHeader);
      }
      return pipeline.answer({ method: request.method, target, headers, body: request.body, signal: request.signal });
    },
  };
}
