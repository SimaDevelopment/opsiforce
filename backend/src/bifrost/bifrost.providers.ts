import type { KeyType, BifrostProviderConfig } from './bifrost.types';

const defaultProviderConfigs: Record<KeyType, BifrostProviderConfig[]> = {
  chat: [
    { provider: 'openai', weight: 0 },
    { provider: 'anthropic', weight: 1 },
    { provider: 'custom-openai-1', weight: 0.3 },
  ],
  backend: [
    { provider: 'openai', weight: 1 },
    { provider: 'anthropic', weight: 1 },
  ],
};

const upstreamProvider = process.env.BIFROST_UPSTREAM_PROVIDER;
const fallbackProvider = process.env.BIFROST_FALLBACK_PROVIDER;
// A numeric zero keeps the fallback eligible for Bifrost's automatic fallback
// chain without sending it primary traffic. Provider model catalogs limit which
// models can use the fallback. Requests must use unqualified model names.
const upstreamConfigs: BifrostProviderConfig[] = upstreamProvider
  ? [
      { provider: upstreamProvider, weight: 1 },
      ...(fallbackProvider && fallbackProvider !== upstreamProvider ? [{ provider: fallbackProvider, weight: 0 }] : []),
    ]
  : [];

export const BIFROST_PROVIDER_CONFIGS: Record<KeyType, BifrostProviderConfig[]> = upstreamProvider
  ? {
      chat: upstreamConfigs,
      backend: upstreamConfigs,
    }
  : defaultProviderConfigs;
