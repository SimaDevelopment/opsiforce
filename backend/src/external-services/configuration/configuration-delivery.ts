import { Injectable } from '@nestjs/common';
import type { Field } from '@opsiforce/external-service-sdk';
import type { JsonValue } from '../../common/json';
import { SecretSealer } from '../../sealing/secret-sealer';
import type { RegisteredService } from '../registry/service-registry';
import {
  isPlainValues,
  servicePlaceOf,
  StoredSecret,
  type ConfigurationOwner,
  type ConfigurationValues,
  type SealingPlaceOf,
} from './configuration-values';
import { unsavedWithStoredSecrets } from './form-save';
import { projectPlaceOf } from './project-configuration.store';

export interface DraftDelivery {
  form: readonly Field[];
  stored: ConfigurationValues;
  unsaved: ConfigurationValues;
  placeOf: SealingPlaceOf;
}

export interface HookDelivery {
  service: RegisteredService;
  owner: ConfigurationOwner;
  previous: ConfigurationValues | null;
  current: ConfigurationValues | null;
}

export interface ProjectHookDelivery {
  service: RegisteredService;
  projectEnvironmentId: string;
  previous: ConfigurationValues | null;
  current: ConfigurationValues | null;
}

export interface DeliveredHook {
  previous: ConfigurationValues | null;
  current: ConfigurationValues | null;
}

export interface StoredProjectValues {
  projectEnvironmentId: string;
  values: ConfigurationValues;
}

export interface FetchDelivery {
  service: RegisteredService;
  owner: ConfigurationOwner;
  serviceConfiguration: ConfigurationValues;
  projectConfigurations: readonly StoredProjectValues[];
}

export interface FetchedConfigurations {
  serviceConfiguration: ConfigurationValues;
  projectConfigurations: StoredProjectValues[];
}

@Injectable()
export class ConfigurationDelivery {
  constructor(private readonly sealer: SecretSealer) {}

  forDraft(delivery: DraftDelivery): ConfigurationValues {
    return this.opened(
      unsavedWithStoredSecrets(delivery.form, delivery.unsaved, delivery.stored),
      delivery.placeOf
    ) as ConfigurationValues;
  }

  forServiceHook(delivery: HookDelivery): DeliveredHook {
    return this.hookChange(delivery, servicePlaceOf(delivery.service, delivery.owner));
  }

  forProjectHook(delivery: ProjectHookDelivery): DeliveredHook {
    return this.hookChange(delivery, projectPlaceOf(delivery.service, delivery.projectEnvironmentId));
  }

  forFetch(fetch: FetchDelivery): FetchedConfigurations {
    const { service, owner } = fetch;
    return {
      serviceConfiguration: this.opened(
        fetch.serviceConfiguration,
        servicePlaceOf(service, owner)
      ) as ConfigurationValues,
      projectConfigurations: fetch.projectConfigurations.map((entry) => ({
        projectEnvironmentId: entry.projectEnvironmentId,
        values: this.opened(entry.values, projectPlaceOf(service, entry.projectEnvironmentId)) as ConfigurationValues,
      })),
    };
  }

  private hookChange(
    change: { previous: ConfigurationValues | null; current: ConfigurationValues | null },
    placeOf: SealingPlaceOf
  ): DeliveredHook {
    return {
      previous: this.opened(change.previous, placeOf) as ConfigurationValues | null,
      current: this.opened(change.current, placeOf) as ConfigurationValues | null,
    };
  }

  private opened(value: unknown, placeOf: SealingPlaceOf): unknown {
    if (value instanceof StoredSecret)
      return this.sealer.open(value.sealed as unknown as JsonValue, placeOf(value.path));
    if (Array.isArray(value)) return value.map((entry) => this.opened(entry, placeOf));
    if (isPlainValues(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.opened(entry, placeOf)]));
    }
    return value;
  }
}
