import { Injectable } from '@nestjs/common';
import type { Bound } from '@opsiforce/external-service-sdk';
import {
  createBoundsChecker,
  findBoundSites,
  valueFieldsOf,
  type BoundSite,
  type ValueField,
} from '@opsiforce/external-service-sdk/platform';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceProjectConfigs, projectEnvironments, projects } from '../../../db/schema';
import { TEST_PROJECT_KIND } from '../../project/project.types';
import { isPlainValues, itemFieldsOf, type ConfigurationValues } from '../configuration/configuration-values';
import { projectConfigurationFromStored, storedShapeOf } from '../configuration/project-configuration.store';
import type { RegisteredService } from '../registry/service-registry';

export interface EventReceiver {
  projectEnvironmentId: string;
  directory: string;
}

export interface RoutedEvent {
  type: string;
  data: Record<string, unknown>;
}

type Containment = Record<string, unknown>;

function contains(containment: Containment): SQL {
  return sql`${externalServiceProjectConfigs.values} @> ${JSON.stringify(containment)}::jsonb`;
}

function storedKeysOf(field: ValueField | undefined, key: string): string[] {
  if (!field) return [key];
  return field.was === undefined ? [field.key] : [field.key, field.was];
}

function storedValue(field: ValueField | undefined, value: string): unknown {
  return field?.type === 'multiselect' ? [value] : value;
}

function readPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const token of pointer.split('/').slice(1)) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isPlainValues(current)) current = current[key];
    else return undefined;
  }
  return current;
}

function boundContainments(
  service: RegisteredService,
  bound: Bound,
  site: BoundSite,
  data: Record<string, unknown>
): Containment[] {
  const [fieldKey = '', itemKey] = bound.path.split('[].');
  const field = valueFieldsOf(service.manifest.projectForm ?? []).find((candidate) => candidate.key === fieldKey);
  if (itemKey === undefined) {
    return storedKeysOf(field, fieldKey).map((key) => ({ [key]: storedValue(field, site.value) }));
  }

  const itemField =
    field?.type === 'list'
      ? valueFieldsOf(itemFieldsOf(field)).find((candidate) => candidate.key === itemKey)
      : undefined;
  const where: Containment = {};
  for (const [whereKey, pointer] of Object.entries(bound.where ?? {})) {
    const wanted = readPointer(data, pointer);
    if (wanted === undefined) return [];
    where[whereKey] = wanted;
  }
  return storedKeysOf(field, fieldKey).flatMap((listKey) =>
    storedKeysOf(itemField, itemKey).map((key) => ({
      [listKey]: [{ ...where, [key]: storedValue(itemField, site.value) }],
    }))
  );
}

function isTestProjectOf(builderChatId: string): SQL {
  return sql`((${projects.kind} = ${TEST_PROJECT_KIND} and ${projects.createdByProjectId} = ${builderChatId}) is true)`;
}

function laneReceivers(service: RegisteredService): SQL[] {
  if (!service.home) return [];
  const testProject = isTestProjectOf(service.home.builderChatId);
  return [service.home.lane === 'development' ? testProject : sql`not ${testProject}`];
}

function unlessContainments(bound: Bound): Containment[] {
  return Object.entries(bound.unless ?? {}).map(([key, value]) => ({ [key]: value }));
}

@Injectable()
export class EventReceivers {
  async of(
    service: RegisteredService,
    event: RoutedEvent,
    serviceConfiguration: ConfigurationValues
  ): Promise<EventReceiver[]> {
    const sites = findBoundSites(service.manifest, { event: event.type }, event.data);
    if (sites.length === 0 && service.origin === 'built_in') return [];

    const conditions = [
      eq(externalServiceProjectConfigs.externalServiceId, service.id),
      contains({ receive: { [event.type]: true } }),
      ...laneReceivers(service),
    ];
    for (const site of sites) {
      const bound = service.manifest.bounds?.[site.bound];
      if (!bound) return [];
      const alternatives = [...boundContainments(service, bound, site, event.data), ...unlessContainments(bound)];
      if (alternatives.length === 0) return [];
      conditions.push(or(...alternatives.map(contains)) as SQL);
    }

    const candidates = await db
      .select({
        projectEnvironmentId: externalServiceProjectConfigs.projectEnvironmentId,
        values: externalServiceProjectConfigs.values,
        directory: projectEnvironments.directory,
      })
      .from(externalServiceProjectConfigs)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceProjectConfigs.projectEnvironmentId))
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(and(...conditions));

    return candidates
      .filter((candidate) => {
        const configuration = projectConfigurationFromStored(service, candidate.values);
        if (configuration.receive[event.type] !== true) return false;
        const bounds = createBoundsChecker({
          manifest: service.manifest,
          projectConfiguration: storedShapeOf(configuration),
          serviceConfiguration,
        });
        return bounds.check({ event: event.type }, event.data) === null;
      })
      .map(({ projectEnvironmentId, directory }) => ({ projectEnvironmentId, directory }));
  }
}
