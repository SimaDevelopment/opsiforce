import {
  computeManifestHash,
  createServiceRuntime,
  type AnyServiceHandlers,
  type ServiceResponse,
  type ServiceRoute,
  type ServiceRuntime,
  type ServiceRuntimeOptions,
  type WireContext,
} from '@opsiforce/external-service-sdk/server';

import type { JsonObject } from './fixtures.ts';

export function echoManifest(): JsonObject {
  return {
    sdk: 1,
    displayName: 'Echo',
    description: 'Answers with what it was given.',
    operations: {
      echo: { kind: 'read', description: 'Echo the input.', input: { type: 'object' } },
    },
  };
}

export function runtimeFor(
  manifest: JsonObject,
  handlers: Omit<AnyServiceHandlers, 'manifestHash'>,
  options: Partial<ServiceRuntimeOptions> = {}
): ServiceRuntime {
  return createServiceRuntime({
    manifest,
    handlers: { manifestHash: computeManifestHash(manifest), ...handlers },
    log: () => {},
    ...options,
  });
}

export function wireContext(overrides: Partial<WireContext> = {}): WireContext {
  return {
    callId: 'call_test_1',
    caller: {
      tenantId: 'tenant_acme',
      projectId: 'project_1',
      environmentId: 'env_1',
      environment: 'production',
      via: 'agent',
    },
    serviceConfiguration: {},
    projectConfiguration: {},
    webhookUrl: 'https://opsiforce.example/api/external-services/webhooks/echo',
    ...overrides,
  };
}

export interface JsonResponse {
  status: number;
  headers: Record<string, string>;
  json: JsonObject;
}

export function decodeJson(response: ServiceResponse): JsonResponse {
  const text = new TextDecoder().decode(response.body);
  return { status: response.status, headers: response.headers, json: text === '' ? undefined : JSON.parse(text) };
}

export async function dispatchJson(
  runtime: ServiceRuntime,
  route: ServiceRoute,
  name: string | undefined,
  body: unknown
): Promise<JsonResponse> {
  return decodeJson(await runtime.dispatch({ route, name, body }));
}
