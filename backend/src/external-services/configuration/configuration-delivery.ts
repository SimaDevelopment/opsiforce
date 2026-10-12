import { Injectable } from '@nestjs/common';
import { trimmedToReferencedItems } from '@opsiforce/external-service-sdk/platform';
import type { JsonValue } from '../../common/json';
import { SecretSealer } from '../../sealing/secret-sealer';
import type { RegisteredService } from '../registry/service-registry';
import {
  isListItem,
  isPlainValues,
  servicePlaceOf,
  StoredSecret,
  type ConfigurationOwner,
  type ConfigurationValues,
  type SealingPlaceOf,
} from './configuration-values';
import { unsavedWithStoredSecrets } from './form-save';
import { projectPlaceOf } from './project-configuration.store';

export interface DeliveredConfigurations {
  serviceConfiguration: ConfigurationValues;
  projectConfiguration: ConfigurationValues;
  sentSecrets: string[];
}

export interface ProjectDelivery {
  service: RegisteredService;
  owner: ConfigurationOwner;
  serviceConfiguration: ConfigurationValues;
  projectEnvironmentId: string;
  projectConfiguration: ConfigurationValues;
}

export interface EditedItem {
  list: string;
  id: string;
}

export interface FormCallDelivery {
  service: RegisteredService;
  owner: ConfigurationOwner;
  serviceConfiguration: ConfigurationValues;
  unsaved: ConfigurationValues;
  editedItem: EditedItem | null;
}

export interface ProjectFormCallDelivery extends FormCallDelivery {
  projectEnvironmentId: string;
  projectConfiguration: ConfigurationValues;
}

export interface DeliveredFormCall {
  serviceConfiguration: ConfigurationValues;
  values: ConfigurationValues;
  sentSecrets: string[];
}

function itemOf(values: ConfigurationValues, editedItem: EditedItem): ConfigurationValues {
  const items = values[editedItem.list];
  return (
    (Array.isArray(items) ? items : []).find(
      (item): item is ConfigurationValues => isListItem(item) && item.id === editedItem.id
    ) ?? { id: editedItem.id }
  );
}

export interface HookDelivery {
  service: RegisteredService;
  owner: ConfigurationOwner;
  serviceConfiguration: ConfigurationValues;
  previous: ConfigurationValues | null;
  current: ConfigurationValues | null;
}

export interface ProjectHookDelivery extends HookDelivery {
  projectEnvironmentId: string;
}

export interface DeliveredHook {
  serviceConfiguration: ConfigurationValues;
  previous: ConfigurationValues | null;
  current: ConfigurationValues | null;
  sentSecrets: string[];
}

@Injectable()
export class ConfigurationDelivery {
  constructor(private readonly sealer: SecretSealer) {}

  forProject(delivery: ProjectDelivery): DeliveredConfigurations {
    const { service, owner, projectEnvironmentId } = delivery;
    const sentSecrets: string[] = [];
    const serviceConfiguration = this.opened(
      trimmedToReferencedItems(
        service.manifest.projectForm,
        delivery.serviceConfiguration,
        delivery.projectConfiguration
      ),
      servicePlaceOf(service, owner),
      sentSecrets
    ) as ConfigurationValues;
    const projectConfiguration = this.opened(
      delivery.projectConfiguration,
      projectPlaceOf(service, projectEnvironmentId),
      sentSecrets
    ) as ConfigurationValues;
    return { serviceConfiguration, projectConfiguration, sentSecrets };
  }

  forServiceFormCall(delivery: FormCallDelivery): DeliveredFormCall {
    const { service, owner, editedItem } = delivery;
    const sentSecrets: string[] = [];
    const unsaved = this.opened(
      unsavedWithStoredSecrets(service.manifest.serviceForm ?? [], delivery.unsaved, delivery.serviceConfiguration),
      servicePlaceOf(service, owner),
      sentSecrets
    ) as ConfigurationValues;
    if (!editedItem) return { serviceConfiguration: unsaved, values: unsaved, sentSecrets };
    const item = itemOf(unsaved, editedItem);
    return { serviceConfiguration: { ...unsaved, [editedItem.list]: [item] }, values: item, sentSecrets };
  }

  forProjectFormCall(delivery: ProjectFormCallDelivery): DeliveredFormCall {
    const { service, owner, projectEnvironmentId, editedItem } = delivery;
    const sentSecrets: string[] = [];
    const merged = unsavedWithStoredSecrets(
      service.manifest.projectForm ?? [],
      delivery.unsaved,
      delivery.projectConfiguration
    );
    const serviceConfiguration = this.opened(
      trimmedToReferencedItems(service.manifest.projectForm, delivery.serviceConfiguration, merged),
      servicePlaceOf(service, owner),
      sentSecrets
    ) as ConfigurationValues;
    const unsaved = this.opened(
      merged,
      projectPlaceOf(service, projectEnvironmentId),
      sentSecrets
    ) as ConfigurationValues;
    return { serviceConfiguration, values: editedItem ? itemOf(unsaved, editedItem) : unsaved, sentSecrets };
  }

  forInbound(
    service: RegisteredService,
    owner: ConfigurationOwner,
    serviceConfiguration: ConfigurationValues
  ): Omit<DeliveredConfigurations, 'projectConfiguration'> {
    const sentSecrets: string[] = [];
    const opened = this.opened(
      serviceConfiguration,
      servicePlaceOf(service, owner),
      sentSecrets
    ) as ConfigurationValues;
    return { serviceConfiguration: opened, sentSecrets };
  }

  forServiceHook(delivery: HookDelivery): DeliveredHook {
    const { service, owner } = delivery;
    const sentSecrets: string[] = [];
    const placeOf = servicePlaceOf(service, owner);
    return {
      serviceConfiguration: this.opened(delivery.serviceConfiguration, placeOf, sentSecrets) as ConfigurationValues,
      previous: this.opened(delivery.previous, placeOf, sentSecrets) as ConfigurationValues | null,
      current: this.opened(delivery.current, placeOf, sentSecrets) as ConfigurationValues | null,
      sentSecrets,
    };
  }

  forProjectHook(delivery: ProjectHookDelivery): DeliveredHook {
    const { service, owner, projectEnvironmentId } = delivery;
    const sentSecrets: string[] = [];
    const referencing = [delivery.previous, delivery.current].filter(
      (values): values is ConfigurationValues => values !== null
    );
    const projectPlace = projectPlaceOf(service, projectEnvironmentId);
    return {
      serviceConfiguration: this.opened(
        trimmedToReferencedItems(service.manifest.projectForm, delivery.serviceConfiguration, ...referencing),
        servicePlaceOf(service, owner),
        sentSecrets
      ) as ConfigurationValues,
      previous: this.opened(delivery.previous, projectPlace, sentSecrets) as ConfigurationValues | null,
      current: this.opened(delivery.current, projectPlace, sentSecrets) as ConfigurationValues | null,
      sentSecrets,
    };
  }

  private opened(value: unknown, placeOf: SealingPlaceOf, sentSecrets: string[]): unknown {
    if (value instanceof StoredSecret) {
      const plaintext = this.sealer.open(value.sealed as unknown as JsonValue, placeOf(value.path));
      if (typeof plaintext === 'string') sentSecrets.push(plaintext);
      return plaintext;
    }
    if (Array.isArray(value)) return value.map((entry) => this.opened(entry, placeOf, sentSecrets));
    if (isPlainValues(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.opened(entry, placeOf, sentSecrets)])
      );
    }
    return value;
  }
}
