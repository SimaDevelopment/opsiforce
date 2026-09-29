import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelUnknown } from './agent-errors';

interface ReasoningOption {
  type?: string;
  values?: string[];
}

interface CatalogModel {
  name?: string;
  reasoning_options?: ReasoningOption[];
}

interface CatalogProvider {
  name?: string;
  models?: Record<string, CatalogModel>;
}

export type ModelCatalog = Record<string, CatalogProvider>;

let cached: ModelCatalog | null = null;

export function modelCatalogPath(): string {
  return join(process.cwd(), '..', 'agent-config', 'models.json');
}

export function loadModelCatalog(path = modelCatalogPath()): ModelCatalog {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`The model catalog is missing at ${path}; the backend image must ship agent-config/models.json`, {
      cause,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`The model catalog at ${path} is not valid JSON`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The model catalog at ${path} is not an object keyed by provider`);
  }

  const catalog = parsed as ModelCatalog;
  const offersAModel = Object.values(catalog).some((provider) => Object.keys(provider?.models ?? {}).length > 0);
  if (!offersAModel) throw new Error(`The model catalog at ${path} declares no models, so no agent could run`);

  return catalog;
}

export function readModelCatalog(): ModelCatalog {
  cached ??= loadModelCatalog();
  return cached;
}

export function assertModelCatalogShipped(): void {
  readModelCatalog();
}

export function effortValues(model: CatalogModel): string[] {
  const effort = model.reasoning_options?.find((option) => option.type === 'effort');
  return effort?.values ?? [];
}

export function assertModelSelection(model: string, variant: string | null, catalog = readModelCatalog()): void {
  const separator = model.indexOf('/');
  const providerId = separator === -1 ? model : model.slice(0, separator);
  const modelId = separator === -1 ? '' : model.slice(separator + 1);

  const provider = catalog[providerId];
  if (!provider) throw modelUnknown('provider', providerId);

  const entry = provider.models?.[modelId];
  if (!entry) throw modelUnknown('model', modelId);

  if (variant !== null && !effortValues(entry).includes(variant)) throw modelUnknown('variant', variant);
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  efforts: string[];
}

export interface ModelCatalogProvider {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}

export function modelCatalogResponse(catalog = readModelCatalog()): ModelCatalogProvider[] {
  return Object.entries(catalog)
    .map(([providerId, provider]) => ({
      id: providerId,
      name: provider.name ?? providerId,
      models: Object.entries(provider.models ?? {})
        .map(([modelId, model]) => ({
          id: `${providerId}/${modelId}`,
          name: model.name ?? modelId,
          efforts: effortValues(model),
        }))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    }))
    .filter((provider) => provider.models.length > 0)
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
