import type { BifrostAllowedRequests, BifrostRequestPathOverrides } from '../bifrost/bifrost.types';

export type BaseFormatId = 'openai' | 'anthropic';

export type ModelProviderKind = 'official-api-key' | 'compatible-endpoint' | 'linked-account' | 'azure-foundry';

export interface ConnectionTest {
  path: string;
  headers: (key: string) => Record<string, string>;
}

export interface CompatibleEndpointShape {
  connectionTestPath: string;
  requestPathOverrides?: BifrostRequestPathOverrides;
}

export interface BaseFormat {
  id: BaseFormatId;
  bifrostBaseProviderType: BaseFormatId;
  opencodeProviderId: string;
  modelCatalogKey: string;
  imageModels: readonly string[];
  officialApiUrl: string;
  connectionTest: ConnectionTest;
  compatibleEndpoint: CompatibleEndpointShape;
  allowedRequestsByKind: Partial<Record<ModelProviderKind, BifrostAllowedRequests>>;
}

const NATIVE_RESPONSES: BifrostAllowedRequests = {
  list_models: false,
  chat_completion: true,
  chat_completion_stream: true,
  responses: true,
  responses_stream: true,
  count_tokens: false,
};

const RESPONSES_TRANSLATED_TO_CHAT_COMPLETIONS: BifrostAllowedRequests = {
  ...NATIVE_RESPONSES,
  responses: false,
  responses_stream: false,
};

const LINKED_ACCOUNT_REQUESTS: BifrostAllowedRequests = {
  ...NATIVE_RESPONSES,
  responses: false,
  image_generation: true,
  image_edit: true,
};

const ANTHROPIC_NATIVE: BifrostAllowedRequests = { ...NATIVE_RESPONSES, count_tokens: true };

export const BASE_FORMATS: Record<BaseFormatId, BaseFormat> = {
  openai: {
    id: 'openai',
    bifrostBaseProviderType: 'openai',
    opencodeProviderId: 'openai',
    modelCatalogKey: 'openai',
    imageModels: ['gpt-image-2'],
    officialApiUrl: 'https://api.openai.com/v1',
    connectionTest: { path: '/models', headers: (key) => ({ authorization: `Bearer ${key}` }) },
    compatibleEndpoint: {
      connectionTestPath: '/models',
      requestPathOverrides: { chat_completion: '/chat/completions', chat_completion_stream: '/chat/completions' },
    },
    allowedRequestsByKind: {
      'official-api-key': NATIVE_RESPONSES,
      'compatible-endpoint': RESPONSES_TRANSLATED_TO_CHAT_COMPLETIONS,
      'linked-account': LINKED_ACCOUNT_REQUESTS,
    },
  },
  anthropic: {
    id: 'anthropic',
    bifrostBaseProviderType: 'anthropic',
    opencodeProviderId: 'anthropic',
    modelCatalogKey: 'anthropic',
    imageModels: [],
    officialApiUrl: 'https://api.anthropic.com/v1',
    connectionTest: {
      path: '/models',
      headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    },
    compatibleEndpoint: { connectionTestPath: '/v1/models' },
    allowedRequestsByKind: {
      'official-api-key': ANTHROPIC_NATIVE,
      'compatible-endpoint': ANTHROPIC_NATIVE,
    },
  },
};

export function allowedKinds(format: BaseFormat): ModelProviderKind[] {
  return Object.keys(format.allowedRequestsByKind) as ModelProviderKind[];
}

export const BASE_FORMAT_IDS = Object.keys(BASE_FORMATS) as BaseFormatId[];

export function isBaseFormatId(value: string): value is BaseFormatId {
  return (BASE_FORMAT_IDS as string[]).includes(value);
}

const CREATABLE_KINDS = new Set<ModelProviderKind>(['official-api-key', 'compatible-endpoint', 'linked-account']);
const KEYED_KINDS = new Set<ModelProviderKind>(['official-api-key', 'compatible-endpoint']);

export function creatableKinds(format: BaseFormat): ModelProviderKind[] {
  return [...allowedKinds(format).filter((kind) => CREATABLE_KINDS.has(kind)), 'azure-foundry'];
}

export function keyedKinds(format: BaseFormat): ModelProviderKind[] {
  return allowedKinds(format).filter((kind) => KEYED_KINDS.has(kind));
}

export function catalogModelsByFormat(modelsOf: (format: BaseFormat) => string[]): Record<BaseFormatId, string[]> {
  return Object.fromEntries(BASE_FORMAT_IDS.map((id) => [id, modelsOf(BASE_FORMATS[id])])) as Record<
    BaseFormatId,
    string[]
  >;
}

export function creatableKindsByFormat(): Record<BaseFormatId, ModelProviderKind[]> {
  return Object.fromEntries(BASE_FORMAT_IDS.map((id) => [id, creatableKinds(BASE_FORMATS[id])])) as Record<
    BaseFormatId,
    ModelProviderKind[]
  >;
}
