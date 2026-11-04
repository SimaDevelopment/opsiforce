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

export const MAX_CREATED_AGENTS = 'maxCreatedAgents';

export const CREATED_PROJECTS_WORKSPACE = 'createdProjectsWorkspace';

export const OTHER_PROJECTS = 'otherProjects';

export const CREATED_PROJECT_AGENTS = 'createdProjectAgents';

export type PublicApiSettingKey =
  | PublicApiSwitch
  | typeof MAX_CREATED_PROJECTS
  | typeof MAX_CREATED_AGENTS
  | typeof OTHER_PROJECTS
  | typeof CREATED_PROJECT_AGENTS
  | typeof CREATED_PROJECTS_WORKSPACE;

type PublicApiLimit = typeof MAX_CREATED_PROJECTS | typeof MAX_CREATED_AGENTS;

export type PublicApiSettingValues = Record<PublicApiSwitch, boolean> &
  Record<PublicApiLimit, number> & {
    [OTHER_PROJECTS]: string[];
    [CREATED_PROJECT_AGENTS]: string[];
    [CREATED_PROJECTS_WORKSPACE]: string | null;
  };

function idsIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

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

export function limitDefault(manifest: ServiceManifest, key: PublicApiLimit): number {
  const value = fieldOf(manifest, key).default;
  if (typeof value !== 'number') throw new Error(`The ${PUBLIC_API_SERVICE} "${key}" has no default`);
  return value;
}

function limitIn(manifest: ServiceManifest, values: Record<string, unknown>, key: PublicApiLimit): number {
  const value = values[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : limitDefault(manifest, key);
}

export function builderChatPublicApiSettings(manifest: ServiceManifest): PublicApiSettingValues {
  return {
    ...BUILDER_CHAT_PUBLIC_API_SWITCHES,
    [MAX_CREATED_PROJECTS]: limitDefault(manifest, MAX_CREATED_PROJECTS),
    [MAX_CREATED_AGENTS]: limitDefault(manifest, MAX_CREATED_AGENTS),
    [OTHER_PROJECTS]: [],
    [CREATED_PROJECT_AGENTS]: [],
    [CREATED_PROJECTS_WORKSPACE]: null,
  };
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
    const workspace = values[CREATED_PROJECTS_WORKSPACE];
    return {
      ...(Object.fromEntries(PUBLIC_API_SWITCHES.map((key) => [key, values[key] === true])) as Record<
        PublicApiSwitch,
        boolean
      >),
      [MAX_CREATED_PROJECTS]: limitIn(service.manifest, values, MAX_CREATED_PROJECTS),
      [MAX_CREATED_AGENTS]: limitIn(service.manifest, values, MAX_CREATED_AGENTS),
      [OTHER_PROJECTS]: idsIn(values[OTHER_PROJECTS]),
      [CREATED_PROJECT_AGENTS]: idsIn(values[CREATED_PROJECT_AGENTS]),
      [CREATED_PROJECTS_WORKSPACE]: typeof workspace === 'string' && workspace !== '' ? workspace : null,
    };
  }

  limitOf(settings: PublicApiSettingValues | null, key: PublicApiLimit): number {
    return settings ? settings[key] : limitDefault(this.requireService().manifest, key);
  }

  labelOf(key: PublicApiSettingKey): string {
    const manifest = this.requireService().manifest;
    return `${manifest.displayName} → ${fieldOf(manifest, key).label ?? key}`;
  }

  unreachedProjectDetail(): string {
    return `The calling Project reaches only the Projects it created and those listed under "${this.labelOf(OTHER_PROJECTS)}", and only while the person who created it can see them. Someone who can configure the calling Project's External Services can add a Project there.`;
  }

  otherProjectNotDeletedDetail(): string {
    return `The calling Project may delete only the Projects it created, never those listed under "${this.labelOf(OTHER_PROJECTS)}".`;
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
