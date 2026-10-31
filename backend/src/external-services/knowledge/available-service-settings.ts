import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ServiceSettingsCatalog,
  type ServiceConfigurationOptions,
  type ProjectlessOptionsAnswer,
  type SettableService,
} from '../../store/service-settings-catalog';
import { callersOwner } from '../configuration/configuration-values';
import { serviceConfigurationOptionsOf } from '../configuration/project-service-views';
import { ServiceAvailability } from '../configuration/service-availability';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { FormCalls } from '../gate/form-calls';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';

@Injectable()
export class AvailableServiceSettings extends ServiceSettingsCatalog {
  constructor(
    private readonly availability: ServiceAvailability,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly formCalls: FormCalls,
    private readonly registry: ServiceRegistry
  ) {
    super();
  }

  async availableServices(tenantId: string): Promise<SettableService[]> {
    return (await this.availability.availableToTenant(tenantId)).map(settableOf);
  }

  async availableService(tenantId: string, externalServiceId: string): Promise<SettableService | null> {
    const service = await this.availableCopy(tenantId, externalServiceId);
    return service ? settableOf(service) : null;
  }

  async tenantService(tenantId: string, externalServiceId: string): Promise<SettableService | null> {
    const service = await this.registry.byIdForTenant(tenantId, externalServiceId);
    return service ? settableOf(service) : null;
  }

  async serviceConfigurationOptions(
    tenantId: string,
    externalServiceId: string
  ): Promise<ServiceConfigurationOptions[]> {
    const service = await this.availableCopy(tenantId, externalServiceId);
    if (!service) return [];
    return serviceConfigurationOptionsOf(
      service,
      await this.serviceConfigurations.read(service, callersOwner(service))
    );
  }

  async callProjectlessOptions(
    tenantId: string,
    externalServiceId: string,
    name: string,
    body: unknown,
    askedBy: string
  ): Promise<ProjectlessOptionsAnswer> {
    const service = await this.availableCopy(tenantId, externalServiceId);
    if (!service) throw new NotFoundException(`No available External Service ${externalServiceId}`);
    return this.formCalls.callProjectlessOptions({ service, name, body, tenantId, askedBy });
  }

  private async availableCopy(tenantId: string, externalServiceId: string): Promise<RegisteredService | undefined> {
    const available = await this.availability.availableToTenant(tenantId);
    return available.find((candidate) => candidate.id === externalServiceId);
  }
}

function settableOf(service: RegisteredService): SettableService {
  return {
    id: service.id,
    slug: service.slug,
    displayName: service.manifest.displayName,
    manifest: {
      projectForm: service.manifest.projectForm,
      connectedByDefault: service.manifest.connectedByDefault === true,
    },
  };
}
