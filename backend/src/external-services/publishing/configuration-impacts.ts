import { Injectable } from '@nestjs/common';
import { valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, externalServiceProjectConfigs, projectEnvironments, projects } from '../../../db/schema';
import { TEST_PROJECT_KIND } from '../../project/project.types';
import { isPlainValues, type ConfigurationValues } from '../configuration/configuration-values';
import { projectConfigurationFromStored } from '../configuration/project-configuration.store';
import { defaultsMissingFrom, type WrittenDefault } from '../configuration/published-defaults';
import type { RegisteredService } from '../registry/service-registry';

export interface FieldRename {
  from: string;
  to: string;
}

export interface ConsumerImpact {
  projectId: string;
  projectTitle: string | null;
  projectEnvironmentId: string;
  environmentName: string | null;
  renamed: FieldRename[];
  needsAttention: string[];
  newDefaults: WrittenDefault[];
}

export interface ConfigurationImpact {
  configurations: number;
  renamed: (FieldRename & { configurations: number })[];
  needsAttention: { field: string; configurations: number }[];
  newDefaults: (WrittenDefault & { configurations: number })[];
  consumers: ConsumerImpact[];
}

interface StoredConsumer {
  projectId: string;
  projectTitle: string | null;
  projectEnvironmentId: string;
  environmentName: string | null;
  values: ConfigurationValues;
}

function fieldOf(path: string): string {
  const [list, , itemField] = path.split('.');
  return itemField === undefined ? path : `${list}[].${itemField}`;
}

function renamesOf(next: RegisteredService, stored: ConfigurationValues): FieldRename[] {
  return valueFieldsOf(next.manifest.projectForm ?? [])
    .filter((field) => field.was !== undefined && stored[field.key] === undefined && stored[field.was] !== undefined)
    .map((field) => ({ from: field.was as string, to: field.key }));
}

function consumerImpactOf(
  current: RegisteredService | null,
  next: RegisteredService,
  consumer: StoredConsumer
): ConsumerImpact {
  const before = current ? projectConfigurationFromStored(current, consumer.values) : null;
  const after = projectConfigurationFromStored(next, consumer.values);
  const missingBefore = new Set(before?.missing.map(fieldOf) ?? []);
  return {
    projectId: consumer.projectId,
    projectTitle: consumer.projectTitle,
    projectEnvironmentId: consumer.projectEnvironmentId,
    environmentName: consumer.environmentName,
    renamed: renamesOf(next, consumer.values),
    needsAttention: [...new Set(after.missing.map(fieldOf))].filter((field) => !missingBefore.has(field)),
    newDefaults: defaultsMissingFrom(next.manifest.projectForm ?? [], consumer.values),
  };
}

function isAffected(impact: ConsumerImpact): boolean {
  return impact.renamed.length + impact.needsAttention.length + impact.newDefaults.length > 0;
}

function tally<T>(impacts: ConsumerImpact[], pick: (impact: ConsumerImpact) => T[], keyOf: (entry: T) => string) {
  const counts = new Map<string, { entry: T; configurations: number }>();
  for (const impact of impacts) {
    for (const entry of pick(impact)) {
      const key = keyOf(entry);
      const counted = counts.get(key) ?? { entry, configurations: 0 };
      counted.configurations += 1;
      counts.set(key, counted);
    }
  }
  return [...counts.values()];
}

@Injectable()
export class ConfigurationImpacts {
  async between(
    current: RegisteredService | null,
    next: RegisteredService,
    builderChatId: string
  ): Promise<ConfigurationImpact> {
    const consumers = await this.consumersOf(next.id, builderChatId);
    const impacts = consumers.map((consumer) => consumerImpactOf(current, next, consumer));
    return {
      configurations: consumers.length,
      renamed: tally(
        impacts,
        (impact) => impact.renamed,
        (rename) => `${rename.from}>${rename.to}`
      ).map(({ entry, configurations }) => ({ ...entry, configurations })),
      needsAttention: tally(
        impacts,
        (impact) => impact.needsAttention,
        (field) => field
      ).map(({ entry, configurations }) => ({ field: entry, configurations })),
      newDefaults: tally(
        impacts,
        (impact) => impact.newDefaults,
        (written) => written.key
      ).map(({ entry, configurations }) => ({ ...entry, configurations })),
      consumers: impacts.filter(isAffected),
    };
  }

  private async consumersOf(serviceId: string, builderChatId: string): Promise<StoredConsumer[]> {
    const rows = await db
      .select({
        projectId: projects.id,
        projectTitle: projects.title,
        projectEnvironmentId: projectEnvironments.id,
        environmentName: environments.name,
        values: externalServiceProjectConfigs.values,
      })
      .from(externalServiceProjectConfigs)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceProjectConfigs.projectEnvironmentId))
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .where(
        and(
          eq(externalServiceProjectConfigs.externalServiceId, serviceId),
          or(
            isNull(projects.createdByProjectId),
            ne(projects.createdByProjectId, builderChatId),
            isNull(projects.kind),
            ne(projects.kind, TEST_PROJECT_KIND)
          )
        )
      )
      .orderBy(asc(projects.title), asc(environments.name));
    return rows.map((row) => ({ ...row, values: isPlainValues(row.values) ? row.values : {} }));
  }
}
