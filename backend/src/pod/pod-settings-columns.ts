import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  resourcePresets,
  type agentPodSettings,
  type projectPodSettings,
  type tenantAgentPodSettings,
} from '../../db/schema';
import type { PodResources } from './pod-classes';

type PodSettingsTable = typeof projectPodSettings | typeof agentPodSettings | typeof tenantAgentPodSettings;

export function podSettingsColumns(table: PodSettingsTable) {
  return {
    presetId: table.presetId,
    presetName: sql<
      string | null
    >`(select ${resourcePresets.name} from ${resourcePresets} where ${resourcePresets.id} = ${table.presetId})`,
    cpuMillicores: table.cpuMillicores,
    memoryRequestMib: table.memoryRequestMib,
    memoryLimitMib: table.memoryLimitMib,
  };
}

export function hasResources(table: PodSettingsTable, resources: PodResources): SQL | undefined {
  return and(
    eq(table.cpuMillicores, resources.cpuMillicores),
    eq(table.memoryRequestMib, resources.memoryRequestMib),
    eq(table.memoryLimitMib, resources.memoryLimitMib)
  );
}

export function storedPodSettings(settings: { presetId: string | null } & PodResources) {
  return {
    presetId: settings.presetId,
    cpuMillicores: settings.cpuMillicores,
    memoryRequestMib: settings.memoryRequestMib,
    memoryLimitMib: settings.memoryLimitMib,
  };
}
