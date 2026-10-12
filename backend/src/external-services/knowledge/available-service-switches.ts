import { Injectable } from '@nestjs/common';
import { ServiceSwitchCatalog, type SwitchableService } from '../../store/service-switch-catalog';
import { ServiceAvailability } from '../configuration/service-availability';

@Injectable()
export class AvailableServiceSwitches extends ServiceSwitchCatalog {
  constructor(private readonly availability: ServiceAvailability) {
    super();
  }

  async availableService(tenantId: string, externalServiceId: string): Promise<SwitchableService | null> {
    const available = await this.availability.availableToTenant(tenantId);
    const service = available.find((candidate) => candidate.id === externalServiceId);
    if (!service) return null;
    return {
      id: service.id,
      slug: service.slug,
      displayName: service.manifest.displayName,
      manifest: { operations: service.manifest.operations, events: service.manifest.events },
    };
  }
}
