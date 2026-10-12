import { Injectable } from '@nestjs/common';
import { ServiceRegistry } from '../registry/service-registry';
import { ProjectConfigurationStore } from './project-configuration.store';

export const PUBLIC_API_SERVICE = 'public-api';

@Injectable()
export class OperationSwitches {
  constructor(
    private readonly registry: ServiceRegistry,
    private readonly projectConfigurationStore: ProjectConfigurationStore
  ) {}

  async isOn(slug: string, projectEnvironmentId: string, operation: string): Promise<boolean> {
    const service = this.registry.bySlug(slug);
    if (!service) return false;
    const configuration = await this.projectConfigurationStore.read(service, projectEnvironmentId);
    return configuration.operations[operation] === true;
  }
}
