import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import type { AgentServiceSettings } from '../../db/schema';

export type ServiceSwitches = Pick<ServiceManifest, 'operations' | 'events'>;

export interface SwitchableService {
  id: string;
  slug: string;
  displayName: string;
  manifest: ServiceSwitches;
}

export abstract class ServiceSwitchCatalog {
  abstract availableService(tenantId: string, externalServiceId: string): Promise<SwitchableService | null>;
}

export interface KeptServiceSettings {
  settings: AgentServiceSettings;
  dropped: string[];
}

export function keptServiceSettings(manifest: ServiceSwitches, settings: AgentServiceSettings): KeptServiceSettings {
  const operations = Object.keys(manifest.operations ?? {});
  const events = Object.keys(manifest.events ?? {});
  return {
    settings: {
      operations: operations.filter((name) => settings.operations.includes(name)),
      receive: events.filter((type) => settings.receive.includes(type)),
    },
    dropped: [
      ...settings.operations.filter((name) => !operations.includes(name)),
      ...settings.receive.filter((type) => !events.includes(type)),
    ],
  };
}

export function settingsWithinGrants(
  manifest: ServiceSwitches,
  settings: AgentServiceSettings,
  grants: { canConfigureProjects: boolean }
): KeptServiceSettings {
  if (grants.canConfigureProjects) return { settings, dropped: [] };
  const isRead = (name: string) => manifest.operations?.[name]?.kind === 'read';
  return {
    settings: { ...settings, operations: settings.operations.filter(isRead) },
    dropped: settings.operations.filter((name) => !isRead(name)),
  };
}

function isNames(names: unknown): boolean {
  return Array.isArray(names) && names.every((name) => typeof name === 'string');
}

export function isAgentServiceSettings(value: unknown): value is AgentServiceSettings {
  if (typeof value !== 'object' || value === null) return false;
  const { operations, receive } = value as Record<string, unknown>;
  return isNames(operations) && isNames(receive);
}
