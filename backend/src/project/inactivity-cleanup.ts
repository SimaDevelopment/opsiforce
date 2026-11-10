import { BadRequestException } from '@nestjs/common';
import { MissingPermissionException } from '../permission/missing-permission.exception';
import { hasPermission } from '../permission/permission.utils';
import type { Permission } from '../permission/permission.constants';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db';
import {
  agentInactivityCleanup,
  agents,
  projectEnvironments,
  projectSettings,
  projects,
  tenantAgentInactivityCleanup,
} from '../../db/schema';
import type { DbExecutor } from '../common/locks';
import type { ProjectService } from './project.service';

const HOUR_MS = 60 * 60 * 1000;
export const MIN_INACTIVITY_MS = HOUR_MS;
export const MAX_INACTIVITY_MS = 3650 * 24 * HOUR_MS;

export interface InactivityCleanup {
  disableAfter: number | null;
  deleteAfter: number | null;
}

const activityEnvironments = alias(projectEnvironments, 'activity_environments');

export const projectLastActivityAt = sql<Date>`greatest(${projects.createdAt}, (
  select max(${activityEnvironments.lastActiveAt})
  from ${projectEnvironments} as ${activityEnvironments}
  where ${activityEnvironments.projectId} = ${projects.id}
))`.mapWith(projects.createdAt);

export type InactivityCleanupField = keyof InactivityCleanup;

export interface InactivityCleanupGrants {
  canDisableProjects: boolean;
  canDeleteProjects: boolean;
}

export interface InactivityCleanupStep {
  action: 'delete' | 'disable';
  done: string;
  field: InactivityCleanupField;
  defaultField: `default${Capitalize<InactivityCleanupField>}`;
  permission: Permission;
  grant: keyof InactivityCleanupGrants;
  onlyEnabledProjects: boolean;
  runIfStill(projectService: ProjectService, projectId: string, tenantId: string, condition: SQL): Promise<boolean>;
}

export const INACTIVITY_CLEANUP_STEPS: readonly InactivityCleanupStep[] = [
  {
    action: 'delete',
    done: 'deleted',
    field: 'deleteAfter',
    defaultField: 'defaultDeleteAfter',
    permission: 'can_delete_project',
    grant: 'canDeleteProjects',
    onlyEnabledProjects: false,
    runIfStill: (projectService, projectId, tenantId, condition) =>
      projectService.removeIfStill(projectId, tenantId, condition),
  },
  {
    action: 'disable',
    done: 'disabled',
    field: 'disableAfter',
    defaultField: 'defaultDisableAfter',
    permission: 'can_disable_project',
    grant: 'canDisableProjects',
    onlyEnabledProjects: true,
    runIfStill: (projectService, projectId, tenantId, condition) =>
      projectService.disableIfStill(projectId, tenantId, condition),
  },
];

export function perStep<T>(value: (step: InactivityCleanupStep) => T): Record<InactivityCleanupField, T> {
  return Object.fromEntries(INACTIVITY_CLEANUP_STEPS.map((step) => [step.field, value(step)])) as Record<
    InactivityCleanupField,
    T
  >;
}

export const NO_INACTIVITY_CLEANUP: InactivityCleanup = perStep(() => null);

export function inactivityCleanupColumns(
  table: typeof projectSettings | typeof agentInactivityCleanup | typeof tenantAgentInactivityCleanup
) {
  return perStep((step) => table[step.field]);
}

export function inactivityCleanupOf(row: InactivityCleanup): InactivityCleanup {
  return perStep((step) => row[step.field]);
}

export function inactivityCleanupFrom(value: Partial<Record<InactivityCleanupField, unknown>>): InactivityCleanup {
  return patchedInactivityCleanup(NO_INACTIVITY_CLEANUP, value) ?? NO_INACTIVITY_CLEANUP;
}

export function inactivityCleanupGrants(groupsHeader: string): InactivityCleanupGrants {
  return Object.fromEntries(
    INACTIVITY_CLEANUP_STEPS.map((step) => [step.grant, hasPermission(groupsHeader, step.permission)])
  ) as Record<keyof InactivityCleanupGrants, boolean>;
}

export function assertInactivityCleanupPermitted(
  patch: Partial<Record<InactivityCleanupField, unknown>>,
  grants: InactivityCleanupGrants
): void {
  const missing = INACTIVITY_CLEANUP_STEPS.find((step) => patch[step.field] !== undefined && !grants[step.grant]);
  if (missing) throw new MissingPermissionException(missing.permission);
}

export function inactivityCleanupForCopy(
  carried: InactivityCleanup | null,
  grants: Partial<InactivityCleanupGrants>
): InactivityCleanup | null {
  return INACTIVITY_CLEANUP_STEPS.every((step) => grants[step.grant] === true) ? carried : null;
}

export function validInactivityDuration(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_INACTIVITY_MS || value > MAX_INACTIVITY_MS) {
    throw new BadRequestException({
      code: 'bad_request',
      message: `${field} must be a duration in milliseconds from 1 hour to 3650 days, or null`,
    });
  }
  return value;
}

export function assertDeleteAfterDisable(cleanup: InactivityCleanup): InactivityCleanup {
  const { disableAfter, deleteAfter } = cleanup;
  if (disableAfter !== null && deleteAfter !== null && deleteAfter <= disableAfter) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'Delete after must be longer than Disable after',
    });
  }
  return cleanup;
}

export function patchedInactivityCleanup(
  current: InactivityCleanup,
  patch: Partial<Record<InactivityCleanupField, unknown>>
): InactivityCleanup | null {
  if (INACTIVITY_CLEANUP_STEPS.every((step) => patch[step.field] === undefined)) return null;
  return assertDeleteAfterDisable(
    perStep((step) => {
      const value = patch[step.field];
      return value === undefined ? current[step.field] : validInactivityDuration(value, step.field);
    })
  );
}

export type InactivityCleanupSource = 'own' | 'platform' | 'default';

export interface AgentInactivityCleanup {
  cleanup: InactivityCleanup;
  source: InactivityCleanupSource;
  inherited: InactivityCleanup;
  platformChoice: InactivityCleanup | null;
}

interface AgentInactivityCleanupRows {
  builtIn: boolean;
  own: InactivityCleanup | null;
  platform: InactivityCleanup | null;
}

async function readAgentInactivityCleanupRows(
  agentId: string,
  tenantId: string | null,
  executor: DbExecutor
): Promise<AgentInactivityCleanupRows> {
  const [agent] = await executor.select({ origin: agents.origin }).from(agents).where(eq(agents.id, agentId)).limit(1);
  const [agentRow] = await executor
    .select(inactivityCleanupColumns(agentInactivityCleanup))
    .from(agentInactivityCleanup)
    .where(eq(agentInactivityCleanup.agentId, agentId))
    .limit(1);
  if (agent?.origin !== 'built_in') return { builtIn: false, own: agentRow ?? null, platform: null };
  const [tenantRow] = tenantId
    ? await executor
        .select(inactivityCleanupColumns(tenantAgentInactivityCleanup))
        .from(tenantAgentInactivityCleanup)
        .where(
          and(eq(tenantAgentInactivityCleanup.tenantId, tenantId), eq(tenantAgentInactivityCleanup.agentId, agentId))
        )
        .limit(1)
    : [];
  return { builtIn: true, own: tenantRow ?? null, platform: agentRow ?? null };
}

export async function readAgentInactivityCleanup(
  agentId: string,
  tenantId: string | null,
  tenantDefault: InactivityCleanup,
  executor: DbExecutor = db
): Promise<AgentInactivityCleanup> {
  const { own, platform } = await readAgentInactivityCleanupRows(agentId, tenantId, executor);
  const inherited = platform ?? tenantDefault;
  if (own) return { cleanup: own, source: 'own', inherited, platformChoice: platform };
  return { cleanup: inherited, source: platform ? 'platform' : 'default', inherited, platformChoice: platform };
}

export async function carriedInactivityCleanup(
  agentId: string,
  tenantId: string | null
): Promise<InactivityCleanup | null> {
  const { own, platform } = await readAgentInactivityCleanupRows(agentId, tenantId, db);
  return own ?? platform;
}

export async function writeAgentInactivityCleanup(
  agentId: string,
  cleanup: InactivityCleanup | null,
  executor: DbExecutor = db
): Promise<void> {
  if (!cleanup) {
    await executor.delete(agentInactivityCleanup).where(eq(agentInactivityCleanup.agentId, agentId));
    return;
  }
  await executor
    .insert(agentInactivityCleanup)
    .values({ agentId, ...cleanup })
    .onConflictDoUpdate({ target: agentInactivityCleanup.agentId, set: { ...cleanup, updatedAt: new Date() } });
}

export async function writeTenantAgentInactivityCleanup(
  tenantId: string,
  agentId: string,
  cleanup: InactivityCleanup | null,
  executor: DbExecutor = db
): Promise<void> {
  const target = and(
    eq(tenantAgentInactivityCleanup.tenantId, tenantId),
    eq(tenantAgentInactivityCleanup.agentId, agentId)
  );
  if (!cleanup) {
    await executor.delete(tenantAgentInactivityCleanup).where(target);
    return;
  }
  await executor
    .insert(tenantAgentInactivityCleanup)
    .values({ tenantId, agentId, ...cleanup })
    .onConflictDoUpdate({
      target: [tenantAgentInactivityCleanup.tenantId, tenantAgentInactivityCleanup.agentId],
      set: { ...cleanup, updatedAt: new Date() },
    });
}

export async function inactivityCleanupForNewProject(
  agentId: string,
  tenantId: string,
  tenantDefault: InactivityCleanup
): Promise<InactivityCleanup> {
  return (await readAgentInactivityCleanup(agentId, tenantId, tenantDefault)).cleanup;
}
