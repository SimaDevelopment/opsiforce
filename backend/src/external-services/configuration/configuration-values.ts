import type { Field } from '@opsiforce/external-service-sdk';
import { secretStandIn, valueFieldsOf, type ValueField } from '@opsiforce/external-service-sdk/platform';
import { asEncryptedResourceValue } from '../../common/secret-crypto';
import type { JsonObject, JsonValue } from '../../common/json';
import type { SealedSecret, SecretSealer } from '../../sealing/secret-sealer';

export type ConfigurationValues = Record<string, unknown>;

export type ListItemValues = ConfigurationValues & { id: string };

export type ConfigurationOwner = { tenantId: string | null; environment: 'development' | null };

export const PLATFORM_OWNER: ConfigurationOwner = { tenantId: null, environment: null };

export function callersOwner(service: {
  tenantId: string | null;
  home?: { lane: 'default' | 'development' } | null;
}): ConfigurationOwner {
  return { tenantId: service.tenantId, environment: service.home?.lane === 'development' ? 'development' : null };
}

export class StoredSecret {
  constructor(
    readonly sealed: SealedSecret,
    readonly path: string
  ) {}
}

export type SealingPlaceOf = (path: string) => string;

function sealingPlace(serviceId: string, owner: ConfigurationOwner, path: string): string {
  const ownerName = owner.tenantId ?? 'platform';
  return `${serviceId}|${owner.environment ? `${ownerName}+${owner.environment}` : ownerName}|${path}`;
}

export function servicePlaceOf(service: { id: string }, owner: ConfigurationOwner): SealingPlaceOf {
  return (path) => sealingPlace(service.id, owner, path);
}

export function itemPrefix(path: string, itemId: string): string {
  return `${path}.${itemId}.`;
}

export function isPlainValues(value: unknown): value is ConfigurationValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof StoredSecret);
}

export function isListItem(value: unknown): value is ListItemValues {
  return isPlainValues(value) && typeof value.id === 'string';
}

export function sealedSecretOf(value: unknown): SealedSecret | null {
  try {
    return asEncryptedResourceValue(value as JsonValue);
  } catch {
    return null;
  }
}

export function itemFieldsOf(list: Extract<ValueField, { type: 'list' }>): readonly Field[] {
  return list.item as readonly Field[];
}

export function withStandIns(form: readonly Field[], values: ConfigurationValues): ConfigurationValues {
  const copy: ConfigurationValues = { ...values };
  for (const field of valueFieldsOf(form)) {
    const value = values[field.key];
    if (value instanceof StoredSecret) copy[field.key] = secretStandIn;
    else if (field.type === 'list' && Array.isArray(value)) {
      copy[field.key] = value.map((item) => (isPlainValues(item) ? withStandIns(itemFieldsOf(field), item) : item));
    }
  }
  return copy;
}

export function masked(form: readonly Field[], values: ConfigurationValues): ConfigurationValues {
  const copy: ConfigurationValues = { ...values };
  for (const field of valueFieldsOf(form)) {
    const value = values[field.key];
    if (value instanceof StoredSecret) copy[field.key] = { stored: true };
    else if (field.type === 'list' && Array.isArray(value)) {
      copy[field.key] = value.map((item) => (isPlainValues(item) ? masked(itemFieldsOf(field), item) : item));
    }
  }
  return copy;
}

export function resealed(
  sealer: SecretSealer,
  values: ConfigurationValues,
  from: SealingPlaceOf,
  to: SealingPlaceOf,
  prefix = ''
): ConfigurationValues {
  const copy: ConfigurationValues = {};
  for (const [key, value] of Object.entries(values)) {
    const path = `${prefix}${key}`;
    if (sealedSecretOf(value)) {
      copy[key] = sealer.seal(sealer.open(value as JsonObject, from(path)), to(path));
    } else if (Array.isArray(value)) {
      copy[key] = value.map((item) =>
        isListItem(item) ? { ...resealed(sealer, item, from, to, itemPrefix(path, item.id)), id: item.id } : item
      );
    } else {
      copy[key] = value;
    }
  }
  return copy;
}
