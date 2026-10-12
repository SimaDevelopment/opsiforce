import { Injectable, Logger } from '@nestjs/common';
import { defaultOperationSwitches } from '@opsiforce/external-service-sdk/platform';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments, projects, type AgentServiceSettings } from '../../../db/schema';
import { errorMessage } from '../../common/error-message';
import { DeliveryService } from '../../delivery/delivery.service';
import { SkillDeliveryService } from '../../delivery/skill-delivery.service';
import { ProjectConfigurationSaveHooks } from '../configuration/project-configuration-save-hooks';
import { ProjectConfigurationStore, type Switches } from '../configuration/project-configuration.store';
import { ServiceAvailability } from '../configuration/service-availability';
import { profileIdAt, serviceSettingsCarriedBy } from '../knowledge/service-skill.repository';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';

interface SettingsOfService {
  service: RegisteredService;
  settings: AgentServiceSettings;
}

function switchesOf(declared: Record<string, unknown> | undefined, on: readonly string[]): Switches {
  return Object.fromEntries(Object.keys(declared ?? {}).map((name) => [name, on.includes(name)]));
}

async function creatorOf(projectEnvironmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projectEnvironments)
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .where(eq(projectEnvironments.id, projectEnvironmentId));
  return row?.createdBy ?? null;
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
    await this.projectConfigurationStore.startWith(
      service,
      projectEnvironmentId,
      defaultOperationSwitches(service.manifest)
    );
  }

  async startFromAgentSettings(projectEnvironmentId: string): Promise<void> {
    for (const { service, settings } of await this.agentSettingsOf(projectEnvironmentId)) {
      await this.projectConfigurationStore.startWith(
        service,
        projectEnvironmentId,
        switchesOf(service.manifest.operations, settings.operations),
        switchesOf(service.manifest.events, settings.receive)
      );
    }
  }

  async announceAgentSettings(projectEnvironmentId: string): Promise<void> {
    const userId = await creatorOf(projectEnvironmentId);
    for (const { service } of await this.agentSettingsOf(projectEnvironmentId)) {
      try {
        const current = await this.projectConfigurationStore.read(service, projectEnvironmentId);
        if (current.missing.length > 0) continue;
        await this.saveHooks.saved(service, projectEnvironmentId, { previous: null, current }, userId);
      } catch (err) {
        this.logger.warn(
          `The ${service.slug} save hook for the new Project ${projectEnvironmentId} failed: ${errorMessage(err)}`
        );
      }
    }
  }

  async startCopiedFromAgentSettings(projectEnvironmentId: string): Promise<void> {
    await this.startFromAgentSettings(projectEnvironmentId);
    await this.deliverServiceSkills(projectEnvironmentId);
    await this.announceAgentSettings(projectEnvironmentId);
  }

  private async deliverServiceSkills(projectEnvironmentId: string): Promise<void> {
    const job = { projectEnvironmentId, attempt: 0 };
    try {
      await this.skillDeliveries.deliver(job);
    } catch (err) {
      await this.skillDeliveries.recordFailure(job, err instanceof Error ? err : String(err));
    }
  }

  private async agentSettingsOf(projectEnvironmentId: string): Promise<SettingsOfService[]> {
    const audience = await this.delivery.serviceAudienceFor(projectEnvironmentId);
    if (audience?.agentOrigin !== 'custom') return [];
    const profileId = await profileIdAt(audience.agentId, audience.environmentId);
    const carried = profileId ? await serviceSettingsCarriedBy(profileId) : [];
    if (carried.length === 0) return [];
    const available = new Set(
      (await this.availability.availableToTenant(audience.tenantId)).map((service) => service.id)
    );
    const configured: SettingsOfService[] = [];
    for (const { externalServiceId, serviceSettings } of carried) {
      if (!available.has(externalServiceId)) continue;
      const service = await servableOrNone(this.registry.byIdForEnvironment(projectEnvironmentId, externalServiceId));
      if (service) configured.push({ service, settings: serviceSettings });
    }
    return configured;
  }
}
