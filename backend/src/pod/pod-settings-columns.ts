import { and, eq, type SQL } from 'drizzle-orm';
import type { agentPodSettings, projectPodSettings } from '../../db/schema';
import type { PodResources } from './pod-classes';

type PodSettingsTable = typeof projectPodSettings | typeof agentPodSettings;

export function podSettingsColumns(table: PodSettingsTable) {
  return {
    podClass: table.podClass,
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
