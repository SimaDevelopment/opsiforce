import { Injectable } from '@nestjs/common';
import type { ServiceManifest } from '@opsiforce/external-service-sdk/server';
import { PUBLIC_API_SERVICE } from '../built-ins/public-api-service';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { ProjectConfigurationStore } from './project-configuration.store';

export const PUBLIC_API_SWITCHES = [
  'authorSkillsAndAgents',
  'createAgents',
  'createProjects',
  'driveCreatedProjects',
  'deleteCreatedProjects',
] as const;

export type PublicApiSwitch = (typeof PUBLIC_API_SWITCHES)[number];

export const MAX_CREATED_PROJECTS = 'maxCreatedProjects';

export type PublicApiSettingKey = PublicApiSwitch | typeof MAX_CREATED_PROJECTS;

export type PublicApiSettingValues = Record<PublicApiSwitch, boolean> & { [MAX_CREATED_PROJECTS]: number };

export const BUILDER_CHAT_PUBLIC_API_SWITCHES: Record<PublicApiSwitch, boolean> = {
  authorSkillsAndAgents: true,
  createAgents: false,
  createProjects: true,
  driveCreatedProjects: true,
  deleteCreatedProjects: false,
};

function fieldOf(manifest: ServiceManifest, key: PublicApiSettingKey): { label?: string; default?: unknown } {
  const field = (manifest.projectForm ?? []).find((candidate) => 'key' in candidate && candidate.key === key);
  if (!field) throw new Error(`The ${PUBLIC_API_SERVICE} Project form has no "${key}" field`);
  return field as { label?: string; default?: unknown };
}

export function maxCreatedProjectsDefault(manifest: ServiceManifest): number {
  const value = fieldOf(manifest, MAX_CREATED_PROJECTS).default;
  if (typeof value !== 'number') throw new Error(`The ${PUBLIC_API_SERVICE} "${MAX_CREATED_PROJECTS}" has no default`);
  return value;
}

export function builderChatPublicApiSettings(manifest: ServiceManifest): PublicApiSettingValues {
  return { ...BUILDER_CHAT_PUBLIC_API_SWITCHES, [MAX_CREATED_PROJECTS]: maxCreatedProjectsDefault(manifest) };
}

@Injectable()
export class PublicApiSettings {
  constructor(
    private readonly registry: ServiceRegistry,
    private readonly store: ProjectConfigurationStore
  ) {}

  async of(projectEnvironmentId: string): Promise<PublicApiSettingValues | null> {
    const service = this.service();
    if (!service) return null;
    const configuration = await this.store.read(service, projectEnvironmentId);
    if (!configuration.saved) return null;
    const values = configuration.values as Record<string, unknown>;
    const max = values[MAX_CREATED_PROJECTS];
    return {
      ...(Object.fromEntries(PUBLIC_API_SWITCHES.map((key) => [key, values[key] === true])) as Record<
        PublicApiSwitch,
        boolean
      >),
      [MAX_CREATED_PROJECTS]:
        typeof max === 'number' && Number.isInteger(max) ? max : maxCreatedProjectsDefault(service.manifest),
    };
  }

  async maxCreatedProjectsOf(projectEnvironmentId: string): Promise<number> {
    const settings = await this.of(projectEnvironmentId);
    if (settings) return settings[MAX_CREATED_PROJECTS];
    return maxCreatedProjectsDefault(this.requireService().manifest);
  }

  labelOf(key: PublicApiSettingKey): string {
    const manifest = this.requireService().manifest;
    return `${manifest.displayName} → ${fieldOf(manifest, key).label ?? key}`;
  }

  private service(): RegisteredService | undefined {
    return this.registry.bySlug(PUBLIC_API_SERVICE);
  }

  private requireService(): RegisteredService {
    const service = this.service();
    if (!service) throw new Error(`The ${PUBLIC_API_SERVICE} External Service is not registered`);
    return service;
  }
}
