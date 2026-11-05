import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  agentPodSettings,
  agents,
  projectEnvironments,
  projectPodSettings,
  projects,
  resourcePresets,
  tenantAgentPodSettings,
  tenantResourcePresetOverrides,
  tenantSettings,
  tenants,
} from '../../db/schema';
import { writeAgentPodSettings } from '../agent/agent-pod-settings';
import { isPostgresError, PG_UNIQUE_VIOLATION } from '../common/postgres-errors';
import {
  InvalidPodClassSelection,
  RESOURCE_BOUNDS,
  validPresetName,
  validPresetResources,
  type PodResources,
} from '../pod/pod-classes';
import { PREVIOUS_RELEASE_READS_NUMBERS } from '../pod/pod-settings-columns';
import { presetPodSettings, readPresetCatalog, type CatalogPreset } from '../pod/resource-presets';
import { ProjectPoolService } from '../pool/project-pool.service';
import { ProjectStatus } from '../project/project.types';
import {
  PRESET_APPLY_MODES,
  RESOURCE_PRESET_RESTART_QUEUE,
  type OrganizationPresetsView,
  type PlatformPresetsView,
  type PresetApplied,
  type PresetApplyMode,
  type PresetRestartJobData,
  type PresetUsage,
  type UpdatePresetDto,
} from './resource-preset.types';

const RESTART_STAGGER_MS = 3_000;
const RUNNING_STATUSES = [ProjectStatus.Active, ProjectStatus.Starting];
const NOTHING_APPLIED: PresetApplied = { projects: 0, restarting: 0 };

@Injectable()
export class ResourcePresetService {
  constructor(
    @InjectQueue(RESOURCE_PRESET_RESTART_QUEUE) private readonly restartQueue: Queue<PresetRestartJobData>,
    private readonly poolService: ProjectPoolService
  ) {}

  async platformView(): Promise<PlatformPresetsView> {
    const [catalog, usage, tenantRows, ownCounts, overrideCounts] = await Promise.all([
      readPresetCatalog(null),
      presetUsage(),
      db
        .select({
          tenantId: tenants.id,
          displayName: tenants.displayName,
          defaultPresetName: resourcePresets.name,
        })
        .from(tenants)
        .leftJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
        .leftJoin(resourcePresets, eq(resourcePresets.id, tenantSettings.defaultResourcePresetId))
        .orderBy(asc(tenants.displayName)),
      countBy(resourcePresets.tenantId, isNotNull(resourcePresets.tenantId), resourcePresets),
      countBy(tenantResourcePresetOverrides.tenantId, undefined, tenantResourcePresetOverrides),
    ]);
    const overridden = await overridingTenantsByPreset();

    return {
      bounds: RESOURCE_BOUNDS,
      presets: catalog.presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        resources: preset.resources,
        isDefault: preset.id === catalog.platformDefaultPresetId,
        ...usage(preset.id, (tenantId) => !overridden.get(preset.id)?.has(tenantId)),
      })),
      tenants: tenantRows.map((tenant) => ({
        ...tenant,
        ownPresets: ownCounts.get(tenant.tenantId) ?? 0,
        overrides: overrideCounts.get(tenant.tenantId) ?? 0,
      })),
    };
  }

  async organizationView(tenantId: string): Promise<OrganizationPresetsView> {
    await assertTenantExists(tenantId);
    const [catalog, usage] = await Promise.all([readPresetCatalog(tenantId), presetUsage(tenantId)]);
    return {
      bounds: RESOURCE_BOUNDS,
      presets: catalog.presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        organization: preset.tenantId !== null,
        resources: preset.resources,
        platformResources: preset.platformResources,
        overridden: preset.overridden,
        ...usage(preset.id, () => true),
      })),
      defaultPresetId: catalog.defaultPresetId,
      platformDefaultPresetId: catalog.platformDefaultPresetId,
      ownDefault: catalog.ownDefault,
    };
  }

  async createPreset(tenantId: string | null, rawName: unknown, rawResources: unknown): Promise<void> {
    const name = valid(() => validPresetName(rawName));
    const resources = valid(() => validPresetResources(rawResources));
    if (tenantId) await assertTenantExists(tenantId);
    await assertNameFree(tenantId, name, null);
    await insertOrConflict(name, () =>
      db.insert(resourcePresets).values({ id: crypto.randomUUID(), tenantId, name, ...resources })
    );
    await this.poolService.reconcilePresets();
  }

  /** A platform preset from the platform, or an Organization's own preset or its own numbers for a platform preset. */
  async updatePreset(
    tenantId: string | null,
    presetId: string,
    dto: UpdatePresetDto | undefined
  ): Promise<PresetApplied> {
    const preset = await presetIn(tenantId, presetId);
    const apply = assertApply(dto?.apply ?? 'new');
    const ownedHere = preset.tenantId === tenantId;

    if (dto?.name !== undefined) {
      if (!ownedHere) throw badRequest("A platform preset's name is set on the platform");
      const name = valid(() => validPresetName(dto.name));
      await assertNameFree(tenantId, name, preset.id);
      await insertOrConflict(name, () =>
        db.update(resourcePresets).set({ name, updatedAt: new Date() }).where(eq(resourcePresets.id, preset.id))
      );
    }

    let applied = NOTHING_APPLIED;
    if (dto?.resources !== undefined) {
      const resources = valid(() => validPresetResources(dto.resources));
      if (ownedHere) {
        await db
          .update(resourcePresets)
          .set({ ...resources, updatedAt: new Date() })
          .where(eq(resourcePresets.id, preset.id));
      } else if (tenantId) {
        await db
          .insert(tenantResourcePresetOverrides)
          .values({ tenantId, presetId: preset.id, ...resources })
          .onConflictDoUpdate({
            target: [tenantResourcePresetOverrides.tenantId, tenantResourcePresetOverrides.presetId],
            set: { ...resources, updatedAt: new Date() },
          });
      }
      if (apply === 'all')
        applied = await this.applyToProjects(preset.id, resources, projectScope(tenantId, preset.id));
    }
    await this.poolService.reconcilePresets();
    return applied;
  }

  async removeOverride(tenantId: string, presetId: string, rawApply: unknown): Promise<PresetApplied> {
    const preset = await presetIn(tenantId, presetId);
    const apply = assertApply(rawApply ?? 'new');
    await db
      .delete(tenantResourcePresetOverrides)
      .where(
        and(eq(tenantResourcePresetOverrides.tenantId, tenantId), eq(tenantResourcePresetOverrides.presetId, preset.id))
      );
    const applied =
      apply === 'all'
        ? await this.applyToProjects(preset.id, preset.platformResources, eq(projects.tenantId, tenantId))
        : NOTHING_APPLIED;
    await this.poolService.reconcilePresets();
    return applied;
  }

  /** Moves every Project on the preset in scope to its current numbers, restarting the running ones. */
  async applyPreset(tenantId: string | null, presetId: string): Promise<PresetApplied> {
    const preset = await presetIn(tenantId, presetId);
    return this.applyToProjects(preset.id, preset.resources, projectScope(tenantId, preset.id));
  }

  /** Projects and Agents on the preset keep the numbers they run at, as Custom. */
  async deletePreset(tenantId: string | null, presetId: string): Promise<void> {
    const preset = await presetIn(tenantId, presetId);
    if (preset.tenantId !== tenantId) throw badRequest('A platform preset is deleted on the platform');
    const [row] = await db
      .select({ isDefault: resourcePresets.isDefault })
      .from(resourcePresets)
      .where(eq(resourcePresets.id, preset.id));
    if (row?.isDefault) throw badRequest('Choose another platform default before deleting this preset');

    await db.transaction(async (tx) => {
      const effective = (tenantColumn: SQL) => ({
        cpuMillicores: sql`coalesce((select ${tenantResourcePresetOverrides.cpuMillicores} from ${tenantResourcePresetOverrides} where ${tenantResourcePresetOverrides.presetId} = ${preset.id} and ${tenantResourcePresetOverrides.tenantId} = ${tenantColumn}), ${preset.platformResources.cpuMillicores})`,
        memoryRequestMib: sql`coalesce((select ${tenantResourcePresetOverrides.memoryRequestMib} from ${tenantResourcePresetOverrides} where ${tenantResourcePresetOverrides.presetId} = ${preset.id} and ${tenantResourcePresetOverrides.tenantId} = ${tenantColumn}), ${preset.platformResources.memoryRequestMib})`,
        memoryLimitMib: sql`coalesce((select ${tenantResourcePresetOverrides.memoryLimitMib} from ${tenantResourcePresetOverrides} where ${tenantResourcePresetOverrides.presetId} = ${preset.id} and ${tenantResourcePresetOverrides.tenantId} = ${tenantColumn}), ${preset.platformResources.memoryLimitMib})`,
      });
      await tx.execute(sql`
        insert into ${tenantAgentPodSettings} (tenant_id, agent_id, preset_id, cpu_millicores, memory_request_mib, memory_limit_mib)
        select ${tenantResourcePresetOverrides.tenantId}, ${agentPodSettings.agentId}, null,
          ${tenantResourcePresetOverrides.cpuMillicores}, ${tenantResourcePresetOverrides.memoryRequestMib}, ${tenantResourcePresetOverrides.memoryLimitMib}
        from ${tenantResourcePresetOverrides}
        join ${agentPodSettings} on ${agentPodSettings.presetId} = ${tenantResourcePresetOverrides.presetId}
        join ${agents} on ${agents.id} = ${agentPodSettings.agentId} and ${agents.origin} = 'built_in'
        where ${tenantResourcePresetOverrides.presetId} = ${preset.id}
        on conflict do nothing`);
      await tx
        .update(agentPodSettings)
        .set({
          ...effective(
            sql`(select ${agents.tenantId} from ${agents} where ${agents.id} = ${agentPodSettings.agentId})`
          ),
          ...PREVIOUS_RELEASE_READS_NUMBERS,
        })
        .where(eq(agentPodSettings.presetId, preset.id));
      await tx
        .update(tenantAgentPodSettings)
        .set(effective(sql`${tenantAgentPodSettings.tenantId}`))
        .where(eq(tenantAgentPodSettings.presetId, preset.id));
      await tx.delete(resourcePresets).where(eq(resourcePresets.id, preset.id));
    });
    await this.poolService.reconcilePresets();
  }

  async setPlatformDefault(presetId: unknown): Promise<void> {
    if (typeof presetId !== 'string') throw badRequest('presetId is required');
    const preset = await presetIn(null, presetId);
    await db.transaction(async (tx) => {
      await tx.update(resourcePresets).set({ isDefault: false }).where(eq(resourcePresets.isDefault, true));
      await tx.update(resourcePresets).set({ isDefault: true }).where(eq(resourcePresets.id, preset.id));
    });
    await this.poolService.reconcilePresets();
  }

  /** null makes the Organization follow the platform default again. */
  async setOrganizationDefault(tenantId: string, presetId: unknown): Promise<void> {
    if (presetId !== null && typeof presetId !== 'string') throw badRequest('presetId must be a string or null');
    const id = presetId === null ? null : (await presetIn(tenantId, presetId)).id;
    await db
      .insert(tenantSettings)
      .values({ tenantId, defaultResourcePresetId: id })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { defaultResourcePresetId: id } });
  }

  /** A Built-in Agent's platform choice; null makes it follow the default preset. */
  async setBuiltInAgentPreset(agentId: string, presetId: unknown): Promise<void> {
    if (presetId !== null && typeof presetId !== 'string') throw badRequest('presetId must be a string or null');
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.origin, 'built_in'), isNull(agents.tenantId)));
    if (!agent) throw new NotFoundException(`Built-in Agent ${agentId} not found`);
    const settings = presetId === null ? null : presetPodSettings(await presetIn(null, presetId));
    await writeAgentPodSettings(db, agent.id, settings);
    await this.poolService.reconcileAgent(agent.id);
  }

  /** Restarts are queued before the rows move, so a failure in between leaves the Projects behind and Apply retryable. */
  private async applyToProjects(
    presetId: string,
    resources: PodResources,
    scope: SQL | undefined
  ): Promise<PresetApplied> {
    const behind = await db
      .select({ projectId: projectPodSettings.projectId })
      .from(projectPodSettings)
      .innerJoin(projects, eq(projects.id, projectPodSettings.projectId))
      .where(
        and(
          eq(projectPodSettings.presetId, presetId),
          isNotNull(projects.tenantId),
          scope,
          or(
            ne(projectPodSettings.cpuMillicores, resources.cpuMillicores),
            ne(projectPodSettings.memoryRequestMib, resources.memoryRequestMib),
            ne(projectPodSettings.memoryLimitMib, resources.memoryLimitMib)
          )
        )
      );
    if (behind.length === 0) return NOTHING_APPLIED;
    const projectIds = behind.map((row) => row.projectId);

    const running = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(
        and(
          inArray(projectEnvironments.projectId, projectIds),
          inArray(projectEnvironments.status, RUNNING_STATUSES),
          eq(projects.disabled, false)
        )
      );
    await this.restartQueue.addBulk(
      running.map((env, index) => ({
        name: 'restart',
        data: { projectEnvironmentId: env.id },
        opts: { delay: (index + 1) * RESTART_STAGGER_MS, removeOnComplete: true, removeOnFail: 100 },
      }))
    );
    await db
      .update(projectPodSettings)
      .set({ ...resources, ...PREVIOUS_RELEASE_READS_NUMBERS })
      .where(and(inArray(projectPodSettings.projectId, projectIds), eq(projectPodSettings.presetId, presetId)));
    return { projects: projectIds.length, restarting: running.length };
  }
}

/** The Projects a numbers change reaches: an Organization's own, or every Organization still on the platform's numbers. */
function projectScope(tenantId: string | null, presetId: string): SQL | undefined {
  if (tenantId) return eq(projects.tenantId, tenantId);
  return notInArray(
    projects.tenantId,
    db
      .select({ tenantId: tenantResourcePresetOverrides.tenantId })
      .from(tenantResourcePresetOverrides)
      .where(eq(tenantResourcePresetOverrides.presetId, presetId))
  );
}

async function presetIn(tenantId: string | null, presetId: string): Promise<CatalogPreset> {
  const preset = (await readPresetCatalog(tenantId)).presets.find((entry) => entry.id === presetId);
  if (!preset) throw new NotFoundException(`Preset ${presetId} not found`);
  return preset;
}

async function assertNameFree(tenantId: string | null, name: string, exceptId: string | null): Promise<void> {
  const clash = await db
    .select({ id: resourcePresets.id })
    .from(resourcePresets)
    .where(
      and(
        sql`lower(${resourcePresets.name}) = lower(${name})`,
        tenantId ? or(isNull(resourcePresets.tenantId), eq(resourcePresets.tenantId, tenantId)) : undefined,
        exceptId ? ne(resourcePresets.id, exceptId) : undefined
      )
    )
    .limit(1);
  if (clash.length > 0) throw nameTaken(name);
}

async function insertOrConflict(name: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (isPostgresError(error, PG_UNIQUE_VIOLATION)) throw nameTaken(name);
    throw error;
  }
}

function nameTaken(name: string): ConflictException {
  return new ConflictException({ code: 'conflict', message: `A preset named ${name} already exists` });
}

async function overridingTenantsByPreset(): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({ tenantId: tenantResourcePresetOverrides.tenantId, presetId: tenantResourcePresetOverrides.presetId })
    .from(tenantResourcePresetOverrides);
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const tenantIds = result.get(row.presetId) ?? new Set<string>();
    tenantIds.add(row.tenantId);
    result.set(row.presetId, tenantIds);
  }
  return result;
}

async function presetUsage(
  tenantId?: string
): Promise<(presetId: string, counts: (tenantId: string) => boolean) => PresetUsage> {
  const running = sql`${projectEnvironments.status} in ('active', 'starting') and not ${projects.disabled}`;
  const behind = sql`(
    ${projectPodSettings.cpuMillicores} <> coalesce(${tenantResourcePresetOverrides.cpuMillicores}, ${resourcePresets.cpuMillicores})
    or ${projectPodSettings.memoryRequestMib} <> coalesce(${tenantResourcePresetOverrides.memoryRequestMib}, ${resourcePresets.memoryRequestMib})
    or ${projectPodSettings.memoryLimitMib} <> coalesce(${tenantResourcePresetOverrides.memoryLimitMib}, ${resourcePresets.memoryLimitMib})
  )`;
  const rows = await db
    .select({
      tenantId: projects.tenantId,
      presetId: projectPodSettings.presetId,
      projects: sql<number>`count(distinct ${projects.id})::int`,
      runningPods: sql<number>`(count(${projectEnvironments.id}) filter (where ${running}))::int`,
      behind: sql<number>`(count(distinct ${projects.id}) filter (where ${behind}))::int`,
      behindRunningPods: sql<number>`(count(${projectEnvironments.id}) filter (where ${running} and ${behind}))::int`,
    })
    .from(projectPodSettings)
    .innerJoin(projects, eq(projects.id, projectPodSettings.projectId))
    .innerJoin(resourcePresets, eq(resourcePresets.id, projectPodSettings.presetId))
    .leftJoin(
      tenantResourcePresetOverrides,
      and(
        eq(tenantResourcePresetOverrides.presetId, projectPodSettings.presetId),
        eq(tenantResourcePresetOverrides.tenantId, projects.tenantId)
      )
    )
    .leftJoin(projectEnvironments, eq(projectEnvironments.projectId, projects.id))
    .where(
      and(
        isNotNull(projects.tenantId),
        isNotNull(projectPodSettings.presetId),
        tenantId ? eq(projects.tenantId, tenantId) : undefined
      )
    )
    .groupBy(projects.tenantId, projectPodSettings.presetId);
  return (presetId, counts) => {
    const matching = rows.filter((row) => row.presetId === presetId && row.tenantId && counts(row.tenantId));
    const total = (key: keyof PresetUsage) => matching.reduce((sum, row) => sum + row[key], 0);
    return {
      projects: total('projects'),
      runningPods: total('runningPods'),
      behind: total('behind'),
      behindRunningPods: total('behindRunningPods'),
    };
  };
}

async function countBy(
  column: typeof resourcePresets.tenantId | typeof tenantResourcePresetOverrides.tenantId,
  where: SQL | undefined,
  table: typeof resourcePresets | typeof tenantResourcePresetOverrides
): Promise<Map<string, number>> {
  const rows = await db
    .select({ tenantId: column, count: sql<number>`count(*)::int` })
    .from(table)
    .where(where)
    .groupBy(column);
  return new Map(rows.flatMap((row) => (row.tenantId ? [[row.tenantId, row.count] as const] : [])));
}

function valid<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof InvalidPodClassSelection) throw badRequest(error.message);
    throw error;
  }
}

function badRequest(message: string): BadRequestException {
  return new BadRequestException({ code: 'bad_request', message });
}

function assertApply(apply: unknown): PresetApplyMode {
  if (!PRESET_APPLY_MODES.includes(apply as PresetApplyMode)) {
    throw badRequest(`apply must be one of ${PRESET_APPLY_MODES.join(', ')}`);
  }
  return apply as PresetApplyMode;
}

async function assertTenantExists(tenantId: string): Promise<void> {
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new NotFoundException(`Organization ${tenantId} not found`);
}
