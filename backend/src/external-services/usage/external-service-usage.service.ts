import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, externalServiceUsage, projectEnvironments, projects } from '../../../db/schema';
import type { DbExecutor } from '../../common/locks';
import type { CallRecord } from '../gate/call-log';
import { outcomeOf } from '../gate/call-outcome';
import { ServiceRegistry } from '../registry/service-registry';
import type {
  UsageBucketKey,
  UsageCounters,
  UsageEnvironmentBreakdown,
  UsageProjectBreakdown,
  UsageServiceBreakdown,
  UsageView,
} from './external-service-usage.types';

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const COUNTED_CALL_KIND = 'operation';

interface UsageQueryRow extends UsageCounters {
  service: string;
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  environmentName: string | null;
  isDefault: boolean | null;
}

function noCounts(): UsageCounters {
  return { calls: 0, refused: 0, failed: 0, events: 0 };
}

function addCounts(target: UsageCounters, counts: UsageCounters): void {
  target.calls += counts.calls;
  target.refused += counts.refused;
  target.failed += counts.failed;
  target.events += counts.events;
}

function activity(counts: UsageCounters): number {
  return counts.calls + counts.events;
}

@Injectable()
export class ExternalServiceUsageService {
  constructor(private readonly registry: ServiceRegistry) {}

  async countCall(call: CallRecord, executor: DbExecutor = db): Promise<void> {
    if (call.kind !== COUNTED_CALL_KIND || !call.tenantId || !call.externalServiceId) return;
    const outcome = outcomeOf(call);
    await this.add(
      {
        tenantId: call.tenantId,
        projectId: call.projectId ?? null,
        projectEnvironmentId: call.projectEnvironmentId ?? null,
        service: call.slug,
      },
      { calls: 1, refused: outcome === 'refused' ? 1 : 0, failed: outcome === 'failed' ? 1 : 0, events: 0 },
      executor
    );
  }

  async countEvents(key: UsageBucketKey, events: number): Promise<void> {
    if (events < 1) return;
    await this.add(key, { ...noCounts(), events });
  }

  async countStoredEvents(projectEnvironmentId: string, service: string, events: number): Promise<void> {
    if (events < 1) return;
    const [owner] = await db
      .select({ tenantId: projects.tenantId, projectId: projects.id })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (!owner?.tenantId) return;
    await this.countEvents(
      { tenantId: owner.tenantId, projectId: owner.projectId, projectEnvironmentId, service },
      events
    );
  }

  private async add(key: UsageBucketKey, counts: UsageCounters, executor: DbExecutor = db): Promise<void> {
    await executor
      .insert(externalServiceUsage)
      .values({
        id: crypto.randomUUID(),
        tenantId: key.tenantId,
        projectId: key.projectId,
        projectEnvironmentId: key.projectEnvironmentId,
        service: key.service,
        month: currentMonthStart(),
        ...counts,
      })
      .onConflictDoUpdate({
        target: [
          externalServiceUsage.tenantId,
          externalServiceUsage.projectId,
          externalServiceUsage.projectEnvironmentId,
          externalServiceUsage.service,
          externalServiceUsage.month,
        ],
        set: {
          calls: sql`${externalServiceUsage.calls} + ${counts.calls}`,
          refused: sql`${externalServiceUsage.refused} + ${counts.refused}`,
          failed: sql`${externalServiceUsage.failed} + ${counts.failed}`,
          events: sql`${externalServiceUsage.events} + ${counts.events}`,
          updatedAt: new Date(),
        },
      });
  }

  async view(month: string | undefined, tenantId: string): Promise<UsageView> {
    const requestedMonth = month ? parseMonth(month) : currentMonth();

    const rows = await db
      .select({
        service: externalServiceUsage.service,
        projectId: externalServiceUsage.projectId,
        projectTitle: projects.title,
        projectEnvironmentId: externalServiceUsage.projectEnvironmentId,
        environmentName: environments.name,
        isDefault: projectEnvironments.isDefault,
        calls: externalServiceUsage.calls,
        refused: externalServiceUsage.refused,
        failed: externalServiceUsage.failed,
        events: externalServiceUsage.events,
      })
      .from(externalServiceUsage)
      .leftJoin(projects, eq(projects.id, externalServiceUsage.projectId))
      .leftJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceUsage.projectEnvironmentId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .where(
        and(eq(externalServiceUsage.month, monthStart(requestedMonth)), eq(externalServiceUsage.tenantId, tenantId))
      );

    return { month: requestedMonth, services: buildServices(rows, (service) => this.displayNameOf(service)) };
  }

  private displayNameOf(service: string): string {
    return this.registry.bySlug(service)?.manifest.displayName ?? service;
  }
}

function buildServices(rows: UsageQueryRow[], displayNameOf: (service: string) => string): UsageServiceBreakdown[] {
  const services: UsageServiceBreakdown[] = [];

  for (const row of rows) {
    const service = findOrCreate(
      services,
      (candidate) => candidate.service === row.service,
      () => ({ service: row.service, displayName: displayNameOf(row.service), ...noCounts(), projects: [] })
    );
    const project = findOrCreate(
      service.projects,
      (candidate) => candidate.projectId === row.projectId,
      () => ({
        projectId: row.projectId,
        projectTitle: row.projectTitle,
        deleted: row.projectId === null,
        ...noCounts(),
        environments: [],
      })
    );
    const environment = findOrCreate(
      project.environments,
      (candidate) => candidate.projectEnvironmentId === row.projectEnvironmentId,
      () => ({
        projectEnvironmentId: row.projectEnvironmentId,
        environmentName:
          row.projectEnvironmentId === null ? null : environmentLabel(row.environmentName, row.isDefault ?? false),
        isDefault: row.isDefault ?? false,
        deleted: row.projectEnvironmentId === null,
        ...noCounts(),
      })
    );

    const counts = { calls: row.calls, refused: row.refused, failed: row.failed, events: row.events };
    addCounts(service, counts);
    addCounts(project, counts);
    addCounts(environment, counts);
  }

  return sortServices(services);
}

function sortServices(services: UsageServiceBreakdown[]): UsageServiceBreakdown[] {
  for (const service of services) {
    for (const project of service.projects) {
      project.environments.sort(compareEnvironments);
    }
    service.projects.sort(compareProjects);
  }

  return services.toSorted(byActivityThen((a, b) => a.service.localeCompare(b.service)));
}

function compareProjects(a: UsageProjectBreakdown, b: UsageProjectBreakdown): number {
  if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
  return byActivityThen<UsageProjectBreakdown>((first, second) =>
    (first.projectTitle ?? '').localeCompare(second.projectTitle ?? '')
  )(a, b);
}

function compareEnvironments(a: UsageEnvironmentBreakdown, b: UsageEnvironmentBreakdown): number {
  if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return byActivityThen<UsageEnvironmentBreakdown>((first, second) =>
    (first.environmentName ?? '').localeCompare(second.environmentName ?? '')
  )(a, b);
}

function environmentLabel(environmentName: string | null, isDefault: boolean): string {
  return environmentName ?? (isDefault ? 'Development' : 'Environment');
}

function byActivityThen<T extends UsageCounters>(tiebreak: (a: T, b: T) => number): (a: T, b: T) => number {
  return (a, b) => (activity(b) === activity(a) ? tiebreak(a, b) : activity(b) - activity(a));
}

function findOrCreate<T>(list: T[], match: (item: T) => boolean, create: () => T): T {
  const existing = list.find(match);
  if (existing) return existing;

  const created = create();
  list.push(created);
  return created;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function currentMonthStart(): string {
  return monthStart(currentMonth());
}

function monthStart(month: string): string {
  return `${month}-01`;
}

function parseMonth(month: string): string {
  if (!MONTH_PATTERN.test(month)) {
    throw new BadRequestException(`Invalid month "${month}", expected YYYY-MM`);
  }
  return month;
}
