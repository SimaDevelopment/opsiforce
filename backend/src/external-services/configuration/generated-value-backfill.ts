import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Field } from '@opsiforce/external-service-sdk';
import { valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import { errorMessage } from '../../common/error-message';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { itemFieldsOf, type ConfigurationOwner } from './configuration-values';
import { emptyGeneratedPaths } from './form-save';
import { isGeneratedField } from './generated-values';
import { ProjectConfigurationStore, storedShapeOf, waitsForReceive } from './project-configuration.store';
import { ServiceConfigurationStore } from './service-configuration.store';

function generates(form: readonly Field[]): boolean {
  return valueFieldsOf(form).some(
    (field) => isGeneratedField(field) || (field.type === 'list' && generates(itemFieldsOf(field)))
  );
}

function ownerName(owner: ConfigurationOwner): string {
  return `${owner.tenantId ?? 'platform'}${owner.environment ? `+${owner.environment}` : ''}`;
}

@Injectable()
export class GeneratedValueBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger(GeneratedValueBackfill.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly projectConfigurationStore: ProjectConfigurationStore
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const service of this.registry.list()) {
      if (generates(service.manifest.serviceForm ?? [])) await this.fillServiceConfigurations(service);
      if (generates(service.manifest.projectForm ?? [])) await this.fillProjectConfigurations(service);
    }
  }

  async fillServiceConfigurations(service: RegisteredService): Promise<void> {
    const form = service.manifest.serviceForm ?? [];
    for (const owner of await this.serviceConfigurations.storedOwners(service)) {
      const current = await this.serviceConfigurations.read(service, owner);
      if (emptyGeneratedPaths(form, current.values).length === 0) continue;
      try {
        await this.serviceConfigurations.saveAndReport(service, owner, current.values);
      } catch (error) {
        this.logger.warn(
          `Could not fill the generated values of the ${service.slug} Service configuration of ${ownerName(owner)}: ${errorMessage(error)}`
        );
      }
    }
  }

  async fillProjectConfigurations(service: RegisteredService): Promise<void> {
    const form = service.manifest.projectForm ?? [];
    for (const projectEnvironmentId of await this.projectConfigurationStore.environmentsWithStoredConfiguration(
      service
    )) {
      const current = await this.projectConfigurationStore.read(service, projectEnvironmentId);
      if (waitsForReceive(service, current.receive) || emptyGeneratedPaths(form, current.values).length === 0) continue;
      try {
        await this.projectConfigurationStore.saveAndReport(service, projectEnvironmentId, storedShapeOf(current), {
          keepSwitches: true,
        });
      } catch (error) {
        this.logger.warn(
          `Could not fill the generated values of the ${service.slug} Project configuration of ${projectEnvironmentId}: ${errorMessage(error)}`
        );
      }
    }
  }
}
