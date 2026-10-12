import { Injectable } from '@nestjs/common';
import { GateCallers } from '../gate/gate-caller';
import { HookCalls, type HookFailure } from '../gate/hook-calls';
import type { RegisteredService } from '../registry/service-registry';
import { ConfigurationDelivery } from './configuration-delivery';
import { callersOwner, type ConfigurationValues } from './configuration-values';
import { PendingHooks } from './pending-hooks';
import {
  projectConfigurationFromStored,
  projectPlaceOf,
  ProjectConfigurationStore,
  storedShapeOf,
  type ProjectConfiguration,
  type ProjectConfigurationChange,
} from './project-configuration.store';
import { ServiceConfigurationStore } from './service-configuration.store';

const HOOK = 'onProjectConfigurationSaved';

function stored(configuration: ProjectConfiguration | null): ConfigurationValues | null {
  return configuration?.saved ? storedShapeOf(configuration) : null;
}

function applied(configuration: ProjectConfiguration | null): ConfigurationValues | null {
  return configuration?.missing.length === 0 ? stored(configuration) : null;
}

@Injectable()
export class ProjectConfigurationSaveHooks {
  constructor(
    private readonly store: ProjectConfigurationStore,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly hooks: HookCalls,
    private readonly pending: PendingHooks,
    private readonly delivery: ConfigurationDelivery,
    private readonly callers: GateCallers
  ) {}

  async saved(
    service: RegisteredService,
    projectEnvironmentId: string,
    change: ProjectConfigurationChange,
    userId: string | null = null
  ): Promise<HookFailure | null> {
    const configId = await this.store.rowIdOf(service, projectEnvironmentId);
    if (!configId) return null;
    const caller = await this.callers.ofProjectEnvironment(projectEnvironmentId);
    if (!caller) return null;
    const pending = await this.pending.of({ projectConfigId: configId });
    const previous = pending
      ? applied(pending.previous && projectConfigurationFromStored(service, pending.previous))
      : applied(change.previous);
    const current = stored(change.current);
    const owner = callersOwner(service);
    const serviceConfiguration = await this.serviceConfigurations.read(service, owner);
    const outcome = await this.hooks.call({
      service,
      hook: HOOK,
      caller: {
        tenantId: caller.tenantId,
        projectId: caller.projectId,
        environmentId: projectEnvironmentId,
        environment: caller.environment,
        via: 'form',
      },
      deliver: () =>
        this.delivery.forProjectHook({
          service,
          owner,
          serviceConfiguration: serviceConfiguration.values,
          projectEnvironmentId,
          previous,
          current,
        }),
      record: {
        tenantId: caller.tenantId,
        projectId: caller.projectId,
        projectTitle: caller.projectTitle,
        projectEnvironmentId,
        userId,
      },
    });
    return this.pending.settle(
      { projectConfigId: configId },
      outcome,
      previous,
      projectPlaceOf(service, projectEnvironmentId)
    );
  }

  async retry(
    service: RegisteredService,
    projectEnvironmentId: string,
    userId: string | null
  ): Promise<HookFailure | null> {
    const current = await this.store.read(service, projectEnvironmentId);
    return this.saved(service, projectEnvironmentId, { previous: null, current }, userId);
  }

  async discard(service: RegisteredService, projectEnvironmentId: string): Promise<void> {
    const configId = await this.store.rowIdOf(service, projectEnvironmentId);
    if (configId) await this.pending.clear({ projectConfigId: configId });
  }

  async failureOf(service: RegisteredService, projectEnvironmentId: string): Promise<HookFailure | null> {
    const configId = await this.store.rowIdOf(service, projectEnvironmentId);
    return configId ? ((await this.pending.of({ projectConfigId: configId }))?.failure ?? null) : null;
  }
}
