import type { BifrostProviderConfig } from './bifrost.types';

const upstreamProvider = process.env.BIFROST_UPSTREAM_PROVIDER;
const fallbackProvider = process.env.BIFROST_FALLBACK_PROVIDER;

// Organization settings own chat routing. Deployment overrides apply to the
// backend key; weight zero keeps the fallback out of primary traffic.
export const BACKEND_PROVIDER_CONFIGS: BifrostProviderConfig[] = upstreamProvider
  ? [
      { provider: upstreamProvider, weight: 1, allowed_models: ['*'], key_ids: ['*'] },
      ...(fallbackProvider && fallbackProvider !== upstreamProvider
        ? [{ provider: fallbackProvider, weight: 0, allowed_models: ['*'], key_ids: ['*'] }]
        : []),
    ]
  : [
      { provider: 'openai', weight: 1, allowed_models: ['*'], key_ids: ['*'] },
      { provider: 'anthropic', weight: 1, allowed_models: ['*'], key_ids: ['*'] },
    ];
