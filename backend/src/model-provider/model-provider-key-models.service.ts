import { Injectable, Logger } from '@nestjs/common';
import { db } from '../../db';
import { modelProviders } from '../../db/schema';
import type { ModelCatalog } from '../agent/agent-models';
import { BifrostService } from '../bifrost/bifrost.service';
import type { BifrostProviderKeySummary, BifrostProviderSummary } from '../bifrost/bifrost.types';
import { BASE_FORMATS } from './base-formats';
import { servedModelsOf } from './bifrost-provider-shape';
import { baseFormatOf } from './model-provider.service';

function sameModels(stored: string[] | undefined, served: string[]): boolean {
  const storedSet = new Set(stored ?? []);
  return storedSet.size === served.length && served.every((model) => storedSet.has(model));
}

function isHelmPlaceholder(key: BifrostProviderKeySummary): boolean {
  const value = key.value as { value?: unknown; ref?: unknown } | undefined;
  return value?.value === '' && value.ref === undefined;
}

@Injectable()
export class ModelProviderKeyModelsService {
  private readonly logger = new Logger(ModelProviderKeyModelsService.name);

  constructor(private readonly bifrostService: BifrostService) {}

  async reconcileKeyModels(catalog: ModelCatalog): Promise<void> {
    if (!this.bifrostService.isEnabled()) return;
    let providers: BifrostProviderSummary[];
    try {
      providers = await this.managedProviders();
    } catch (err) {
      this.logger.warn(
        `Model provider keys were not matched to the model catalog; retried at next boot: ${(err as Error).message}`
      );
      return;
    }
    for (const provider of providers) {
      try {
        await this.reconcileProvider(provider, catalog);
      } catch (err) {
        this.logger.warn(
          `The keys of ${provider.name} were not matched to the model catalog; retried at next boot: ${(err as Error).message}`
        );
      }
    }
  }

  private async managedProviders(): Promise<BifrostProviderSummary[]> {
    const rows = await db.selectDistinct({ bifrostProvider: modelProviders.bifrostProvider }).from(modelProviders);
    const inBifrost = new Map((await this.bifrostService.listProviders()).map((provider) => [provider.name, provider]));
    return rows.flatMap(({ bifrostProvider }) => {
      const provider = inBifrost.get(bifrostProvider);
      return provider && provider.baseProviderType !== null && !provider.keyLess ? [provider] : [];
    });
  }

  private async reconcileProvider(provider: BifrostProviderSummary, catalog: ModelCatalog): Promise<void> {
    const format = baseFormatOf(provider);
    if (!format) return;
    const served = servedModelsOf(BASE_FORMATS[format], catalog);
    const keys = await this.bifrostService.listProviderKeys(provider.name);
    for (const key of keys) {
      if (!key.id || key.models?.includes('*') || isHelmPlaceholder(key)) continue;
      if (sameModels(key.models, served)) continue;
      await this.rewriteModels(provider.name, key, served);
    }
  }

  private async rewriteModels(providerName: string, key: BifrostProviderKeySummary, served: string[]): Promise<void> {
    await this.bifrostService.replaceProviderKey(providerName, key.id, { ...key, models: served });
    this.logger.log(`Key ${key.name ?? key.id} of ${providerName} now serves ${served.join(', ')}`);
  }
}
