import { catalogModelIdsOf, readModelCatalog, type ModelCatalog } from '../agent/agent-models';
import type {
  BifrostNetworkConfig,
  BifrostProviderSummary,
  CreateBifrostProviderKeyRequest,
  CreateBifrostProviderRequest,
  UpdateBifrostProviderRequest,
} from '../bifrost/bifrost.types';
import type { BaseFormat, ModelProviderKind } from './base-formats';

const STANDARD_NETWORK_CONFIG: BifrostNetworkConfig = {
  default_request_timeout_in_seconds: 1200,
  max_retries: 2,
  retry_backoff_initial: 500,
  retry_backoff_max: 5000,
  stream_idle_timeout_in_seconds: 3600,
};

const MODEL_PROVIDER_CONCURRENCY = { concurrency: 20, buffer_size: 200 };

export interface BifrostProviderSpec {
  name: string;
  format: BaseFormat;
  kind: ModelProviderKind;
  adminTypedBaseUrl: string | null;
  backendWrittenBaseUrl?: string;
  standard?: boolean;
}

const EVERY_MODEL = ['*'];

export function bifrostProviderPayload(spec: BifrostProviderSpec): CreateBifrostProviderRequest {
  return { provider: spec.name, ...bifrostProviderUpdatePayload(spec) };
}

export function bifrostProviderUpdatePayload(spec: BifrostProviderSpec): UpdateBifrostProviderRequest {
  if (spec.standard) return { network_config: STANDARD_NETWORK_CONFIG };
  const allowedRequests = spec.format.allowedRequestsByKind[spec.kind];
  if (!allowedRequests) throw new Error(`${spec.format.id} has no ${spec.kind} model providers`);
  const requestPathOverrides =
    spec.kind === 'compatible-endpoint' ? spec.format.compatibleEndpoint.requestPathOverrides : undefined;
  return {
    network_config: { ...STANDARD_NETWORK_CONFIG, ...baseUrlConfigOf(spec) },
    concurrency_and_buffer_size: MODEL_PROVIDER_CONCURRENCY,
    custom_provider_config: {
      base_provider_type: spec.format.bifrostBaseProviderType,
      is_key_less: false,
      allowed_requests: allowedRequests,
      ...(requestPathOverrides ? { request_path_overrides: requestPathOverrides } : {}),
    },
  };
}

function baseUrlConfigOf(spec: BifrostProviderSpec): Pick<BifrostNetworkConfig, 'base_url' | 'allow_private_network'> {
  if (spec.backendWrittenBaseUrl) return { base_url: spec.backendWrittenBaseUrl, allow_private_network: true };
  if (spec.adminTypedBaseUrl) return { base_url: spec.adminTypedBaseUrl, allow_private_network: false };
  return {};
}

export function servedModelsOf(format: BaseFormat, catalog: ModelCatalog = readModelCatalog()): string[] {
  return catalogModelIdsOf(format.modelCatalogKey, catalog);
}

export function bifrostProviderKeyName(bifrostName: string): string {
  return `${bifrostName}-key`;
}

export function bifrostProviderKey(spec: BifrostProviderSpec, key: string): CreateBifrostProviderKeyRequest {
  return {
    name: bifrostProviderKeyName(spec.name),
    value: { value: key, type: 'plain_text' },
    models: spec.standard ? EVERY_MODEL : servedModelsOf(spec.format),
    weight: 1,
    enabled: true,
  };
}

export function kindOf(
  provider: BifrostProviderSummary | undefined,
  linkedAccountProxyUrl: string
): ModelProviderKind | null {
  if (!provider) return null;
  if (isServedByLinkedAccountProxy(provider, linkedAccountProxyUrl)) return 'linked-account';
  return provider.baseUrl ? 'compatible-endpoint' : 'official-api-key';
}

export function isServedByLinkedAccountProxy(
  provider: BifrostProviderSummary | undefined,
  linkedAccountProxyUrl: string
): boolean {
  return provider?.baseUrl === linkedAccountProxyUrl;
}
