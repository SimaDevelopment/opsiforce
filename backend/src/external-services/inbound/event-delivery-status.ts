import path from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments } from '../../../db/schema';
import { Doorbell } from '../doorbell/doorbell';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry } from '../registry/service-registry';
import { ExternalServiceStore } from './external-service-store';

export interface EventDeliveryStatusView {
  notYetTaken: number;
  appNotWired: boolean;
}

@Injectable()
export class EventDeliveryStatus {
  private readonly storageMountPath: string;

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly store: ExternalServiceStore,
    private readonly doorbell: Doorbell,
    config: ConfigService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async of(tenantId: string, projectEnvironmentId: string, serviceId: string): Promise<EventDeliveryStatusView> {
    const service = await servableOrNone(this.registry.byIdForEnvironment(projectEnvironmentId, serviceId));
    if (!service || (service.tenantId !== null && service.tenantId !== tenantId)) {
      throw new NotFoundException(`No External Service ${serviceId}`);
    }
    const [environment] = await db
      .select({ directory: projectEnvironments.directory })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (!environment) throw new NotFoundException(`No ProjectEnvironment ${projectEnvironmentId}`);
    return {
      notYetTaken: await this.store.undeliveredEventCount(
        path.join(this.storageMountPath, environment.directory),
        service.slug
      ),
      appNotWired: await this.doorbell.isUnwired(projectEnvironmentId, service.id),
    };
  }
}
