import { BadRequestException, Injectable } from '@nestjs/common';
import { builtInCounters, type BuiltInCounterName } from '@opsiforce/external-service-sdk/server';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from 'sqlite';
import { db } from '../../../db';
import { externalServiceUsage } from '../../../db/schema';
import { isAdaptedBuiltIn } from '../built-ins/built-ins-adapter';
import { knownEnvironments, projectTitles } from '../calls/record-owners';
import { ServiceRecordsHomes, type ServiceCopy } from '../calls/service-records-file';
import { ServiceRegistry } from '../registry/service-registry';

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const ALWAYS_SHOWN: readonly BuiltInCounterName[] = ['requests', 'not_allowed', 'failed'];

const BUILT_IN_ORDER: readonly BuiltInCounterName[] = [...ALWAYS_SHOWN, 'events'];

export type UsageValues = Record<string, number>;

export interface UsageCounter {
  name: string;
  label: string;
  description: string | null;
  builtIn: boolean;
}

export interface UsageEnvironment {
  projectEnvironmentId: string | null;
  environmentName: string | null;
  values: UsageValues;
}

export interface UsageProject {
  projectId: string | null;
  title: string | null;
  deleted: boolean;
  values: UsageValues;
  environments: UsageEnvironment[];
}

export interface ServiceUsageView {
  months: string[];
  month: string | null;
  counters: UsageCounter[];
  projects: UsageProject[];
  service: UsageValues | null;
  totals: UsageValues;
}

interface CountedValue {
  serviceRow: boolean;
  projectId: string | null;
  projectEnvironmentId: string | null;
  name: string;
  label: string;
  description: string | null;
  value: number;
}

interface MonthOfCounts {
  months: string[];
  month: string | null;
  counts: CountedValue[];
}

interface StoredUsage {
  project_id: string | null;
  project_environment_id: string | null;
  name: string;
  label: string;
  description: string | null;
  value: number;
}

const NOTHING_COUNTED: MonthOfCounts = { months: [], month: null, counts: [] };

export function parseUsageMonth(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw new BadRequestException('"month" is a month like 2026-10');
  }
  return value;
}

async function recordedMonth(database: Database, month: string | undefined): Promise<MonthOfCounts> {
  const months = (await database.all<{ month: string }[]>('SELECT DISTINCT month FROM usage ORDER BY month DESC')).map(
    (row) => row.month
  );
  const chosen = month ?? months[0] ?? null;
  if (chosen === null) return NOTHING_COUNTED;
  const rows = await database.all<StoredUsage[]>(
    `SELECT project_id, project_environment_id, name, label, description, value FROM usage WHERE month = ? ORDER BY id`,
    chosen
  );
  return {
    months,
    month: chosen,
    counts: rows.map((row) => ({
      serviceRow: row.project_id === null && row.project_environment_id === null,
      projectId: row.project_id,
      projectEnvironmentId: row.project_environment_id,
      name: row.name,
      label: row.label,
      description: row.description,
      value: row.value,
    })),
  };
}

function descriptionOf(name: string): string | null {
  return Object.hasOwn(builtInCounters, name)
    ? (builtInCounters[name as BuiltInCounterName].description ?? null)
    : null;
}

async function tableMonth(tenantId: string, slug: string, month: string | undefined): Promise<MonthOfCounts> {
  const scope = and(eq(externalServiceUsage.tenantId, tenantId), eq(externalServiceUsage.service, slug));
  const months = (
    await db
      .selectDistinct({ month: externalServiceUsage.month })
      .from(externalServiceUsage)
      .where(scope)
      .orderBy(desc(externalServiceUsage.month))
  ).map((row) => row.month.slice(0, 7));
  const chosen = month ?? months[0] ?? null;
  if (chosen === null) return NOTHING_COUNTED;
  const rows = await db
    .select()
    .from(externalServiceUsage)
    .where(and(scope, eq(externalServiceUsage.month, `${chosen}-01`)));
  return {
    months,
    month: chosen,
    counts: rows.map((row) => ({
      serviceRow: false,
      projectId: row.projectId,
      projectEnvironmentId: row.projectEnvironmentId,
      name: row.name,
      label: row.label,
      description: descriptionOf(row.name),
      value: row.value,
    })),
  };
}

function added(values: UsageValues, name: string, value: number): void {
  values[name] = (values[name] ?? 0) + value;
}

function countersOf(counts: CountedValue[]): UsageCounter[] {
  const counted = new Map<string, CountedValue>();
  for (const count of counts) if (count.value > 0) counted.set(count.name, count);
  const builtIns = BUILT_IN_ORDER.filter((name) => ALWAYS_SHOWN.includes(name) || counted.has(name)).map((name) => ({
    name,
    label: builtInCounters[name].label,
    description: builtInCounters[name].description ?? null,
    builtIn: true,
  }));
  const declared = [...counted.values()]
    .filter((count) => !(BUILT_IN_ORDER as readonly string[]).includes(count.name))
    .map((count) => ({ name: count.name, label: count.label, description: count.description, builtIn: false }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
  return [...builtIns, ...declared];
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

async function viewOf(tenantId: string, { months, month, counts }: MonthOfCounts): Promise<ServiceUsageView> {
  const environmentsById = await knownEnvironments(
    tenantId,
    distinct(counts.map((count) => count.projectEnvironmentId))
  );
  const projectIdOf = (count: CountedValue) =>
    count.projectId ??
    (count.projectEnvironmentId ? (environmentsById.get(count.projectEnvironmentId)?.projectId ?? null) : null);
  const titles = await projectTitles(tenantId, distinct(counts.map(projectIdOf)));

  const totals: UsageValues = {};
  let service: UsageValues | null = null;
  const byProject = new Map<string | null, UsageProject>();
  for (const count of counts) {
    if (count.value <= 0) continue;
    added(totals, count.name, count.value);
    if (count.serviceRow) {
      service ??= {};
      added(service, count.name, count.value);
      continue;
    }
    const projectId = projectIdOf(count);
    let project = byProject.get(projectId);
    if (!project) {
      const known = projectId !== null && titles.has(projectId);
      project = {
        projectId,
        title: projectId === null ? null : (titles.get(projectId) ?? null),
        deleted: !known,
        values: {},
        environments: [],
      };
      byProject.set(projectId, project);
    }
    added(project.values, count.name, count.value);
    let environment = project.environments.find(
      (candidate) => candidate.projectEnvironmentId === count.projectEnvironmentId
    );
    if (!environment) {
      environment = {
        projectEnvironmentId: count.projectEnvironmentId,
        environmentName: count.projectEnvironmentId
          ? (environmentsById.get(count.projectEnvironmentId)?.environmentName ?? null)
          : null,
        values: {},
      };
      project.environments.push(environment);
    }
    added(environment.values, count.name, count.value);
  }

  const defaultFirst = (environment: UsageEnvironment) => {
    const known = environment.projectEnvironmentId ? environmentsById.get(environment.projectEnvironmentId) : undefined;
    return known === undefined ? 2 : known.isDefault ? 0 : 1;
  };
  const projectsShown = [...byProject.values()].toSorted(
    (a, b) => Number(a.deleted) - Number(b.deleted) || (a.title ?? '').localeCompare(b.title ?? '')
  );
  for (const project of projectsShown) {
    project.environments.sort(
      (a, b) => defaultFirst(a) - defaultFirst(b) || (a.environmentName ?? '').localeCompare(b.environmentName ?? '')
    );
  }

  return { months, month, counters: countersOf(counts), projects: projectsShown, service, totals };
}

@Injectable()
export class ServiceUsage {
  constructor(
    private readonly homes: ServiceRecordsHomes,
    private readonly registry: ServiceRegistry
  ) {}

  async view(tenantId: string, serviceId: string, copy: ServiceCopy, month?: string): Promise<ServiceUsageView> {
    const registered = await this.registry.byIdForTenant(tenantId, serviceId);
    if (registered && isAdaptedBuiltIn(registered)) {
      return viewOf(tenantId, await tableMonth(tenantId, registered.slug, month));
    }
    const home = await this.homes.of(tenantId, serviceId, copy);
    const counted = home
      ? await this.homes.read(home, (database) => recordedMonth(database, month), NOTHING_COUNTED)
      : NOTHING_COUNTED;
    return viewOf(tenantId, counted);
  }
}
