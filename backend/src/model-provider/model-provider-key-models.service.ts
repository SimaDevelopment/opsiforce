import { Injectable, Logger } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { db } from '../../db';
import { appliedModelCatalog, modelProviders } from '../../db/schema';
import type { ModelCatalog } from '../agent/agent-models';
import { BifrostService } from '../bifrost/bifrost.service';
import type { BifrostProviderSummary } from '../bifrost/bifrost.types';
import { BASE_FORMATS, BASE_FORMAT_IDS } from './base-formats';
import { servedModelsOf } from './bifrost-provider-shape';
import { isHelmPlaceholder } from './key-model-formats';
import { ModelProvidersService, baseFormatOf } from './model-provider.service';

const EVERY_MODEL = ['*'];

function coversCatalog(stored: string[] | undefined, served: string[]): boolean {
  return served.every((model) => stored?.includes(model));
}

function servedModelsByFormat(catalog: ModelCatalog): Record<string, string[]> {
  return Object.fromEntries(BASE_FORMAT_IDS.map((format) => [format, servedModelsOf(BASE_FORMATS[format], catalog)]));
}

@Injectable()
export class ModelProviderKeyModelsService {
  private readonly logger = new Logger(ModelProviderKeyModelsService.name);

  constructor(
    private readonly bifrostService: BifrostService,
    private readonly modelProvidersService: ModelProvidersService
  ) {}

  async applyModelCatalog(catalog: ModelCatalog): Promise<void> {
    await this.reconcileKeyModels(catalog);
    try {
      await this.rewriteKeysForChangedCatalog(catalog);
    } catch (err) {
      this.logger.warn(
        `The model catalog did not reach every organization's keys; retried at next boot: ${(err as Error).message}`
      );
    }
  }

  async rewriteKeysForChangedCatalog(catalog: ModelCatalog): Promise<void> {
    if (!this.bifrostService.isEnabled()) return;
    const servedModels = servedModelsByFormat(catalog);
    const [applied] = await db.select().from(appliedModelCatalog).limit(1);
    if (!applied) {
      await this.recordAppliedCatalog(servedModels);
      return;
    }
    if (isDeepStrictEqual(applied.servedModels, servedModels)) return;
    const failed = await this.modelProvidersService.rewriteEveryTenantsKeys();
    if (failed.length > 0) {
      this.logger.warn(
        `The model catalog reached the keys of all but ${failed.length} organizations; retried at next boot`
      );
      return;
    }
    await this.recordAppliedCatalog(servedModels);
    this.logger.log("Every organization's keys now follow the model catalog");
  }

  private async recordAppliedCatalog(servedModels: Record<string, string[]>): Promise<void> {
    await db
      .insert(appliedModelCatalog)
      .values({ id: true, servedModels })
      .onConflictDoUpdate({ target: appliedModelCatalog.id, set: { servedModels, appliedAt: new Date() } });
  }

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
      if (!coversCatalog(key.models, served)) continue;
      await this.bifrostService.replaceProviderKey(provider.name, key.id, { ...key, models: EVERY_MODEL });
      this.logger.log(`Key ${key.name ?? key.id} of ${provider.name} now serves every catalog model as it grows`);
    }
  }
}
