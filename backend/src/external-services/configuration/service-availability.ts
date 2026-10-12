import { Injectable } from '@nestjs/common';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { callersOwner } from './configuration-values';
import { ServiceConfigurationStore } from './service-configuration.store';
import type { TolerantRead } from './tolerant-read';

export function isAvailable(read: TolerantRead | undefined): boolean {
  return read !== undefined && read.missing.length === 0;
}

@Injectable()
export class ServiceAvailability {
  constructor(
    private readonly registry: ServiceRegistry,
    private readonly store: ServiceConfigurationStore
  ) {}

  async availableToTenant(tenantId: string | null): Promise<RegisteredService[]> {
    const listed = tenantId === null ? this.registry.list() : await this.registry.listForTenant(tenantId);
    const services = listed.filter((service) => !service.home?.disabled);
    const reads = await this.store.readAllAsCallers(services);
    return services.filter((service) => isAvailable(reads.get(service.id)));
  }

  async isAvailable(service: RegisteredService): Promise<boolean> {
    return !service.home?.disabled && isAvailable(await this.store.read(service, callersOwner(service)));
  }
}
