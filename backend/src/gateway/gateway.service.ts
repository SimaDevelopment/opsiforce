import { Injectable, Logger } from '@nestjs/common';
import crypto from 'crypto';
import { db } from '../../db';
import { gatewayAuditLogs } from '../../db/schema';
import { ServiceProviderRegistry } from './providers/provider-registry';
import type { ServiceProviderContext, ServiceProviderResult } from './providers/service-provider.interface';

// TODO: remove in the release after External Services v2 ships: the dead POST /api/gateway dispatcher (it refuses email, its only provider)
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(private readonly providerRegistry: ServiceProviderRegistry) {}

  async dispatch(
    serviceName: string,
    payload: unknown,
    context: ServiceProviderContext
  ): Promise<ServiceProviderResult> {
    const provider = this.providerRegistry.get(serviceName);
    if (!provider) {
      return {
        success: false,
        error: `Unknown service: ${serviceName}. Available: ${this.providerRegistry.listServices().join(', ')}`,
      };
    }

    const start = Date.now();
    let result: ServiceProviderResult;

    try {
      result = await provider.execute(payload, context);
    } catch (err) {
      result = { success: false, error: (err as Error).message };
    }

    const durationMs = Date.now() - start;
    this.writeAuditLog(context, serviceName, result, durationMs);

    return result;
  }

  private writeAuditLog(
    context: ServiceProviderContext,
    service: string,
    result: ServiceProviderResult,
    durationMs: number
  ): void {
    db.insert(gatewayAuditLogs)
      .values({
        id: crypto.randomUUID(),
        projectId: context.projectId,
        tenantId: context.tenantId,
        service,
        status: result.success ? 'success' : 'error',
        durationMs,
        errorMessage: result.error ?? null,
      })
      .catch((err) => {
        this.logger.warn(`Failed to write audit log: ${(err as Error).message}`);
      });
  }
}
