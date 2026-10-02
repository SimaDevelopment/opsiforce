import { Injectable, Logger } from '@nestjs/common';
import { BifrostService } from '../bifrost/bifrost.service';
import { ModelProvidersService } from '../model-provider/model-provider.service';
import { AVAILABILITY_CACHE_MS, AVAILABILITY_ERROR_CACHE_MS, TRANSCRIPTION_PROVIDER } from './transcription.constants';

interface CachedAvailability {
  available: boolean;
  expiresAt: number;
}

@Injectable()
export class TranscriptionAvailabilityService {
  private readonly logger = new Logger(TranscriptionAvailabilityService.name);
  private cached: CachedAvailability | undefined;
  private pending: Promise<boolean> | undefined;

  constructor(
    private readonly bifrostService: BifrostService,
    private readonly modelProviders: ModelProvidersService
  ) {}

  async isAvailable(tenantId: string): Promise<boolean> {
    if (!(await this.isPlatformProviderKeyed())) return false;
    return this.modelProviders.isProviderReachable(tenantId, TRANSCRIPTION_PROVIDER);
  }

  private async isPlatformProviderKeyed(): Promise<boolean> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.available;
    this.pending ??= this.refresh();
    return this.pending;
  }

  private async refresh(): Promise<boolean> {
    try {
      const available = await this.bifrostService.hasKeyedOpenAiProvider();
      this.cached = { available, expiresAt: Date.now() + AVAILABILITY_CACHE_MS };
      return available;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Transcription availability check failed: ${message}`);
      const available = this.cached?.available ?? false;
      this.cached = { available, expiresAt: Date.now() + AVAILABILITY_ERROR_CACHE_MS };
      return available;
    } finally {
      this.pending = undefined;
    }
  }
}
