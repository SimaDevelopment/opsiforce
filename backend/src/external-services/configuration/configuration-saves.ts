import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../../common/error-message';
import { SkillDeliveryService } from '../../delivery/skill-delivery.service';
import type { HookFailure } from '../gate/hook-calls';
import { ServiceSkillReach } from '../knowledge/service-skill-reach';
import type { RegisteredService } from '../registry/service-registry';
import type { ConfigurationOwner } from './configuration-values';
import { ProjectConfigurationSaveHooks } from './project-configuration-save-hooks';
import type {
  CarriedProjectConfiguration,
  ProjectConfiguration,
  ProjectConfigurationChange,
  ProjectConfigurationSave,
} from './project-configuration.store';
import { isAvailable, ServiceAvailability } from './service-availability';
import { ServiceConfigurationSaveHooks } from './service-configuration-save-hooks';
import type { ServiceConfigurationSave } from './service-configuration.store';

export interface SavedServiceConfiguration extends ServiceConfigurationSave {
  hookFailure: HookFailure | null;
}

export interface SavedProjectConfiguration extends ProjectConfigurationSave {
  hookFailure: HookFailure | null;
}

@Injectable()
export class ConfigurationSaves {
  private readonly logger = new Logger(ConfigurationSaves.name);

  constructor(
    private readonly availability: ServiceAvailability,
    private readonly serviceSkillReach: ServiceSkillReach,
    private readonly skillDeliveries: SkillDeliveryService,
    private readonly serviceHooks: ServiceConfigurationSaveHooks,
    private readonly projectHooks: ProjectConfigurationSaveHooks
  ) {}

  async service(
    service: RegisteredService,
    owner: ConfigurationOwner,
    userId: string | null,
    save: () => Promise<ServiceConfigurationSave>
  ): Promise<SavedServiceConfiguration> {
    const reachesCallers = owner.environment === null;
    const wasAvailable = reachesCallers && (await this.availability.isAvailable(service));
    const saved = await save();
    if (reachesCallers && isAvailable(saved.current) !== wasAvailable) {
      await this.serviceSkillReach.reachEnvironmentsOf(service);
    }
    const hookFailure = await this.serviceHooks.saved(
      service,
      owner,
      { previous: saved.previous?.values ?? null, current: saved.current.values },
      userId
    );
    for (const cascaded of saved.cascaded) {
      this.logger.log(
        `Removed deleted ${service.slug} list items from the Project configuration of ${cascaded.projectEnvironmentId}`
      );
      await this.projectHooks.saved(service, cascaded.projectEnvironmentId, cascaded, userId);
    }
    return { ...saved, hookFailure };
  }

  async project(
    service: RegisteredService,
    projectEnvironmentId: string,
    userId: string | null,
    save: () => Promise<ProjectConfigurationSave>
  ): Promise<SavedProjectConfiguration> {
    const saved = await save();
    await this.deliverOnFirstSave(projectEnvironmentId, saved.previous);
    const hookFailure = await this.projectHooks.saved(service, projectEnvironmentId, saved, userId);
    return { ...saved, hookFailure };
  }

  async carried(
    service: RegisteredService,
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
    carry: () => Promise<CarriedProjectConfiguration | null>
  ): Promise<CarriedProjectConfiguration | null> {
    const carried = await carry();
    if (!carried) return null;
    await this.deliverOnFirstSave(targetEnvironmentId, carried.target.previous);
    await this.announceCarry(service, targetEnvironmentId, carried.target);
    if (carried.receiveTurnedOff.length > 0) await this.announceCarry(service, sourceEnvironmentId, carried.source);
    return carried;
  }

  private async deliverOnFirstSave(projectEnvironmentId: string, previous: ProjectConfiguration | null): Promise<void> {
    if (previous === null) await this.skillDeliveries.enqueueEnvironments([projectEnvironmentId]);
  }

  private async announceCarry(
    service: RegisteredService,
    projectEnvironmentId: string,
    change: ProjectConfigurationChange
  ): Promise<void> {
    try {
      await this.projectHooks.saved(service, projectEnvironmentId, change);
    } catch (err) {
      this.logger.warn(
        `The ${service.slug} save hook for ${projectEnvironmentId} failed after a Publish carry: ${errorMessage(err)}`
      );
    }
  }
}
