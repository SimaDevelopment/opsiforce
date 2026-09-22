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

export const BIFROST_PROVIDER_CONFIGS: Record<KeyType, BifrostProviderConfig[]> = upstreamProvider
  ? {
      chat: [{ provider: upstreamProvider, weight: 1 }],
      backend: [{ provider: upstreamProvider, weight: 1 }],
    }
  : defaultProviderConfigs;
