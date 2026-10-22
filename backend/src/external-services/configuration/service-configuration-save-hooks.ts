import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { HookCalls, type HookFailure } from '../gate/hook-calls';
import type { RegisteredService } from '../registry/service-registry';
import { ConfigurationDelivery } from './configuration-delivery';
import { servicePlaceOf, type ConfigurationOwner, type ConfigurationValues } from './configuration-values';
import { PendingHooks } from './pending-hooks';
import { ServiceConfigurationStore } from './service-configuration.store';
import { readTolerantly } from './tolerant-read';

const HOOK = 'onServiceConfigurationSaved';

export const AWAITING_PUBLISH = 'awaiting-publish';

export interface ServiceConfigurationChange {
  previous: ConfigurationValues | null;
  current: ConfigurationValues | null;
}

@Injectable()
export class ServiceConfigurationSaveHooks {
  constructor(
    private readonly store: ServiceConfigurationStore,
    private readonly hooks: HookCalls,
    private readonly pending: PendingHooks,
    private readonly delivery: ConfigurationDelivery
  ) {}

  async saved(
    service: RegisteredService,
    owner: ConfigurationOwner,
    change: ServiceConfigurationChange
  ): Promise<HookFailure | null> {
    const configId = await this.store.rowIdOf(service, owner);
    if (!configId) return null;
    const pending = await this.pending.of({ serviceConfigId: configId });
    const previous = pending ? this.storedRead(service, pending.previous) : change.previous;
    const outcome = await this.hooks.call({
      service,
      hook: HOOK,
      deliver: () => this.delivery.forServiceHook({ service, owner, previous, current: change.current }),
    });
    return this.pending.settle({ serviceConfigId: configId }, outcome, previous, servicePlaceOf(service, owner));
  }

  async retry(service: RegisteredService, owner: ConfigurationOwner): Promise<HookFailure | null> {
    const current = await this.store.read(service, owner);
    return this.saved(service, owner, { previous: null, current: current.values });
  }

  async discard(service: RegisteredService, owner: ConfigurationOwner): Promise<void> {
    const configId = await this.store.rowIdOf(service, owner);
    if (configId) await this.pending.clear({ serviceConfigId: configId });
  }

  async deferUntilPublished(
    service: RegisteredService,
    owner: ConfigurationOwner,
    previous: ConfigurationValues | null
  ): Promise<void> {
    const configId = await this.store.rowIdOf(service, owner);
    if (!configId) return;
    await this.pending.settle(
      { serviceConfigId: configId },
      {
        kind: 'failed',
        callId: randomUUID(),
        code: AWAITING_PUBLISH,
        detail: 'Applies once the Publish finishes.',
      },
      previous,
      servicePlaceOf(service, owner)
    );
  }

  async runPending(service: RegisteredService, owner: ConfigurationOwner): Promise<HookFailure | null> {
    if (!(await this.failureOf(service, owner))) return null;
    return this.retry(service, owner);
  }

  async failureOf(service: RegisteredService, owner: ConfigurationOwner): Promise<HookFailure | null> {
    const configId = await this.store.rowIdOf(service, owner);
    return configId ? ((await this.pending.of({ serviceConfigId: configId }))?.failure ?? null) : null;
  }

  private storedRead(service: RegisteredService, stored: ConfigurationValues | null): ConfigurationValues | null {
    return stored === null ? null : readTolerantly(service.manifest.serviceForm ?? [], stored).values;
  }
}
