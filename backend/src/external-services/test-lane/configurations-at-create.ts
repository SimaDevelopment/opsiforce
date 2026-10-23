import { Injectable, Logger } from '@nestjs/common';
import { valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import type { AgentServiceSettings } from '../../../db/schema';
import { errorMessage } from '../../common/error-message';
import { DeliveryService } from '../../delivery/delivery.service';
import type { ServiceSkillAudience } from '../../delivery/service-skill-source';
import { SkillDeliveryService } from '../../delivery/skill-delivery.service';
import { ProjectConfigurationSaveHooks } from '../configuration/project-configuration-save-hooks';
import type { ConfigurationValues } from '../configuration/configuration-values';
import {
  ProjectConfigurationStore,
  type ProjectConfigurationStart,
} from '../configuration/project-configuration.store';
import { ServiceAvailability } from '../configuration/service-availability';
import { profileIdAt, serviceSettingsCarriedBy } from '../knowledge/service-skill.repository';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { settableFieldValues } from '../../store/service-switch-catalog';

interface StartingConfiguration {
  service: RegisteredService;
  start: ProjectConfigurationStart;
}

function formDefaultsOf(service: RegisteredService): ConfigurationValues {
  return Object.fromEntries(
    valueFieldsOf(service.manifest.projectForm ?? []).flatMap((field) =>
      'default' in field && field.default !== undefined ? [[field.key, field.default]] : []
    )
  );
}

function startOf(service: RegisteredService, settings: AgentServiceSettings | undefined): ProjectConfigurationStart {
  const carried = settings ? settableFieldValues(service.manifest, settings) : {};
  return { values: { ...formDefaultsOf(service), ...carried } };
}

@Injectable()
export class ConfigurationsAtCreate {
  private readonly logger = new Logger(ConfigurationsAtCreate.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly projectConfigurationStore: ProjectConfigurationStore,
    private readonly availability: ServiceAvailability,
    private readonly delivery: DeliveryService,
    private readonly skillDeliveries: SkillDeliveryService,
    private readonly saveHooks: ProjectConfigurationSaveHooks
  ) {}

  async configureServiceUnderTest(projectEnvironmentId: string): Promise<void> {
    const tested = await this.registry.testedBy(projectEnvironmentId);
    if (!tested) return;
    const service = await servableOrNone(this.registry.byIdForEnvironment(projectEnvironmentId, tested.id));
    if (!service) return;
    await this.projectConfigurationStore.startWith(service, projectEnvironmentId);
  }

  async startConfigurations(projectEnvironmentId: string): Promise<void> {
    for (const { service, start } of await this.startingConfigurationsOf(projectEnvironmentId)) {
      await this.projectConfigurationStore.startWith(service, projectEnvironmentId, start);
    }
  }

  async announceStartedConfigurations(projectEnvironmentId: string): Promise<void> {
    for (const { service } of await this.startingConfigurationsOf(projectEnvironmentId)) {
      try {
        const current = await this.projectConfigurationStore.read(service, projectEnvironmentId);
        if (current.missing.length > 0) continue;
        await this.saveHooks.saved(service, projectEnvironmentId, { previous: null, current });
      } catch (err) {
        this.logger.warn(
          `The ${service.slug} save hook for the new Project ${projectEnvironmentId} failed: ${errorMessage(err)}`
        );
      }
    }
  }

  async startCopiedConfigurations(projectEnvironmentId: string): Promise<void> {
    await this.startConfigurations(projectEnvironmentId);
    await this.deliverServiceSkills(projectEnvironmentId);
    await this.announceStartedConfigurations(projectEnvironmentId);
  }

  private async deliverServiceSkills(projectEnvironmentId: string): Promise<void> {
    const job = { projectEnvironmentId, attempt: 0 };
    try {
      await this.skillDeliveries.deliver(job);
    } catch (err) {
      await this.skillDeliveries.recordFailure(job, err instanceof Error ? err : String(err));
    }
  }

  private async startingConfigurationsOf(projectEnvironmentId: string): Promise<StartingConfiguration[]> {
    const audience = await this.delivery.serviceAudienceFor(projectEnvironmentId);
    if (!audience) return [];
    const settingsByServiceId = await this.agentSettingsOf(audience);
    const starting: StartingConfiguration[] = [];
    for (const available of await this.availability.availableToTenant(audience.tenantId)) {
      const settings = settingsByServiceId.get(available.id);
      if (!settings && !available.manifest.connectedByDefault) continue;
      const service = await servableOrNone(this.registry.byIdForEnvironment(projectEnvironmentId, available.id));
      if (service) starting.push({ service, start: startOf(service, settings) });
    }
    return starting;
  }

  private async agentSettingsOf(audience: ServiceSkillAudience): Promise<Map<string, AgentServiceSettings>> {
    if (audience.agentOrigin !== 'custom') return new Map();
    const profileId = await profileIdAt(audience.agentId, audience.environmentId);
    const carried = profileId ? await serviceSettingsCarriedBy(profileId) : [];
    return new Map(carried.map(({ externalServiceId, serviceSettings }) => [externalServiceId, serviceSettings]));
  }
}
