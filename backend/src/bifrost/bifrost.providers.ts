import type { BifrostProviderConfig } from './bifrost.types';

export const BACKEND_PROVIDER_CONFIGS: BifrostProviderConfig[] = [
  { provider: 'openai', weight: 1, allowed_models: ['*'], key_ids: ['*'] },
  { provider: 'anthropic', weight: 1, allowed_models: ['*'], key_ids: ['*'] },
];
