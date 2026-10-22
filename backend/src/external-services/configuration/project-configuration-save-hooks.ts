import { Injectable } from '@nestjs/common';
import { GateCallers, type GateCaller } from '../gate/gate-caller';
import { HookCalls, type HookFailure, type HookOutcome } from '../gate/hook-calls';
import { platformCallTargetOf } from '../gate/service-dispatcher';
import type { RegisteredService } from '../registry/service-registry';
import { ConfigurationDelivery } from './configuration-delivery';
import type { ConfigurationValues } from './configuration-values';
import { PendingHooks } from './pending-hooks';
import {
  projectConfigurationFromStored,
  projectPlaceOf,
  ProjectConfigurationStore,
  type ProjectConfiguration,
  type ProjectConfigurationChange,
} from './project-configuration.store';

const HOOK = 'onProjectConfigurationSaved';

function stored(configuration: ProjectConfiguration | null): ConfigurationValues | null {
  return configuration?.saved ? configuration.values : null;
}

function applied(configuration: ProjectConfiguration | null): ConfigurationValues | null {
  return configuration?.missing.length === 0 ? stored(configuration) : null;
}

@Injectable()
export class ProjectConfigurationSaveHooks {
  constructor(
    private readonly store: ProjectConfigurationStore,
    private readonly hooks: HookCalls,
    private readonly pending: PendingHooks,
    private readonly delivery: ConfigurationDelivery,
    private readonly callers: GateCallers
  ) {}

  async saved(
    service: RegisteredService,
    projectEnvironmentId: string,
    change: ProjectConfigurationChange
  ): Promise<HookFailure | null> {
    const configId = await this.store.rowIdOf(service, projectEnvironmentId);
    if (!configId) return null;
    const caller = await this.callers.ofProjectEnvironment(projectEnvironmentId);
    if (!caller) return null;
    const pending = await this.pending.of({ projectConfigId: configId });
    const previous = pending
      ? applied(pending.previous && projectConfigurationFromStored(service, pending.previous))
      : applied(change.previous);
    const outcome = await this.send(service, caller, previous, stored(change.current));
    return this.pending.settle(
      { projectConfigId: configId },
      outcome,
      previous,
      projectPlaceOf(service, projectEnvironmentId)
    );
  }

  async disconnected(
    service: RegisteredService,
    projectEnvironmentId: string,
    previous: ProjectConfiguration
  ): Promise<HookFailure | null> {
    const caller = await this.callers.ofProjectEnvironment(projectEnvironmentId);
    if (!caller) return null;
    const outcome = await this.send(service, caller, applied(previous), null);
    return outcome.kind === 'failed' ? { callId: outcome.callId, code: outcome.code, detail: outcome.detail } : null;
  }

  async retry(service: RegisteredService, projectEnvironmentId: string): Promise<HookFailure | null> {
    const current = await this.store.read(service, projectEnvironmentId);
    return this.saved(service, projectEnvironmentId, { previous: null, current });
  }

  async discard(service: RegisteredService, projectEnvironmentId: string): Promise<void> {
    const configId = await this.store.rowIdOf(service, projectEnvironmentId);
    if (configId) await this.pending.clear({ projectConfigId: configId });
  }

  async failureOf(service: RegisteredService, projectEnvironmentId: string): Promise<HookFailure | null> {
    const configId = await this.store.rowIdOf(service, projectEnvironmentId);
    return configId ? ((await this.pending.of({ projectConfigId: configId }))?.failure ?? null) : null;
  }

  private send(
    service: RegisteredService,
    caller: GateCaller,
    previous: ConfigurationValues | null,
    current: ConfigurationValues | null
  ): Promise<HookOutcome> {
    const projectEnvironmentId = caller.projectEnvironmentId;
    return this.hooks.call({
      service,
      hook: HOOK,
      for: platformCallTargetOf(caller),
      deliver: () => this.delivery.forProjectHook({ service, projectEnvironmentId, previous, current }),
    });
  }
}
