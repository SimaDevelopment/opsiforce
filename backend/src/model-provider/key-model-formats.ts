import type { BifrostProviderKeySummary } from '../bifrost/bifrost.types';
import { BASE_FORMATS, type BaseFormatId } from './base-formats';
import { servedModelsOf } from './bifrost-provider-shape';

const EVERY_MODEL = '*';

export function isHelmPlaceholder(key: BifrostProviderKeySummary): boolean {
  const value = key.value as { value?: unknown; ref?: unknown } | undefined;
  return value?.value === '' && value.ref === undefined;
}

export function servingKeysOf(keys: BifrostProviderKeySummary[]): BifrostProviderKeySummary[] {
  return keys.filter((key) => key.enabled !== false && !isHelmPlaceholder(key));
}

export function keyModelsOf(keys: BifrostProviderKeySummary[]): string[] {
  return [...new Set(servingKeysOf(keys).flatMap((key) => key.models ?? []))];
}

export function servesEveryModel(keyModels: string[]): boolean {
  return keyModels.includes(EVERY_MODEL);
}

export function familyModels(keyModels: string[], format: BaseFormatId): string[] {
  const catalog = servedModelsOf(BASE_FORMATS[format]);
  if (keyModels.includes(EVERY_MODEL)) return catalog;
  return keyModels.filter((model) => catalog.includes(model));
}

export function endpointOf(key: BifrostProviderKeySummary | undefined): string | null {
  const endpoint = (key?.azure_key_config as { endpoint?: unknown } | undefined)?.endpoint;
  if (typeof endpoint === 'string') return endpoint;
  const value = (endpoint as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' && !value.startsWith('env.') ? value : null;
}

export function deploymentsOf(key: BifrostProviderKeySummary | undefined): Record<string, string> {
  const aliases = (key?.aliases ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(aliases).flatMap(([model, alias]) => {
      if (typeof alias === 'string') return [[model, alias]];
      const modelId = (alias as { model_id?: unknown } | null)?.model_id;
      return typeof modelId === 'string' ? [[model, modelId]] : [];
    })
  );
}
