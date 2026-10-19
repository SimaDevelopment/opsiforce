import { Injectable, Logger } from '@nestjs/common';
import { SkillDeliveryService } from '../../delivery/skill-delivery.service';
import { callersOwner, type ConfigurationValues } from '../configuration/configuration-values';
import { ConfigurationsAtCreate } from './configurations-at-create';
import { ProjectConfigurationSaveHooks } from '../configuration/project-configuration-save-hooks';
import { ProjectConfigurationStore } from '../configuration/project-configuration.store';
import { ServiceConfigurationSaveHooks } from '../configuration/service-configuration-save-hooks';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { ServiceStateFiles } from '../custom/service-state-files';

@Injectable()
export class TestProjectRefreshes {
  private readonly logger = new Logger(TestProjectRefreshes.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly projectConfigurationStore: ProjectConfigurationStore,
    private readonly saveHooks: ProjectConfigurationSaveHooks,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly serviceSaveHooks: ServiceConfigurationSaveHooks,
    private readonly stateFiles: ServiceStateFiles,
    private readonly skillDeliveries: SkillDeliveryService,
    private readonly configurationsAtCreate: ConfigurationsAtCreate
  ) {}

  async updated(projectEnvironmentId: string): Promise<void> {
    if (!(await this.registry.testedBy(projectEnvironmentId))) return;
    await this.configurationsAtCreate.configureServiceUnderTest(projectEnvironmentId);
    await this.skillDeliveries.enqueueEnvironments([projectEnvironmentId]);
  }

  async resetting(projectEnvironmentId: string): Promise<void> {
    const development = await this.testedDevelopment(projectEnvironmentId);
    if (!development?.home) return;
    await this.deregister(development, projectEnvironmentId);
    const serviceConfiguration = await this.savedServiceConfiguration(development);
    if (serviceConfiguration) await this.savedServiceHook(development, serviceConfiguration, null);
    await this.stateFiles.remove(development.home.projectEnvironmentId);
    this.logger.log(`Reset of a Test Project of ${development.slug} removed Development's ctx.state`);
    if (serviceConfiguration) await this.savedServiceHook(development, null, serviceConfiguration);
  }

  private async savedServiceConfiguration(development: RegisteredService): Promise<ConfigurationValues | null> {
    const owner = callersOwner(development);
    if (!(await this.serviceConfigurations.rowIdOf(development, owner))) return null;
    return (await this.serviceConfigurations.read(development, owner)).values;
  }

  private async savedServiceHook(
    development: RegisteredService,
    previous: ConfigurationValues | null,
    current: ConfigurationValues | null
  ): Promise<void> {
    const failure = await this.serviceSaveHooks.saved(development, callersOwner(development), { previous, current });
    if (failure) {
      this.logger.warn(
        `Reset of a Test Project of ${development.slug}: Development's Service configuration hook failed: ${failure.code}`
      );
    }
  }

  private async deregister(development: RegisteredService, projectEnvironmentId: string): Promise<void> {
    const current = await this.projectConfigurationStore.read(development, projectEnvironmentId);
    if (!current.saved) return;
    try {
      await this.saveHooks.saved(development, projectEnvironmentId, { previous: current, current: null });
    } catch (error) {
      this.logger.warn(
        `Deregistering ${development.slug} for the Test Project ${projectEnvironmentId} failed: ${(error as Error).message}`
      );
    }
  }

  private async testedDevelopment(projectEnvironmentId: string): Promise<RegisteredService | null> {
    const tested = await this.registry.testedBy(projectEnvironmentId);
    if (!tested) return null;
    return servableOrNone(this.registry.development(tested.id), () =>
      this.logger.warn(`Reset of a Test Project of ${tested.slug}: Development's files cannot be read`)
    );
  }
}
