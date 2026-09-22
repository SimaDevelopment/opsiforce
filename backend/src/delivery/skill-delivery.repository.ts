import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  agents,
  projectAgentUpdates,
  projectEnvironments,
  projectSkillDeliveries,
  projectSkillDeliveryState,
  projects,
} from '../../db/schema';
import { AGENT_UPDATE_STALE_AFTER_MS } from '../agent-update/agent-update.reaper';
import { AgentUpdateStatus } from '../agent-update/agent-update.types';
import { ProjectStatus } from '../project/project.types';

export interface FanOutTarget {
  projectEnvironmentId: string;
  projectId: string;
  projectTitle: string | null;
  /** A kind-stamped Project is a Builder chat or a test Project: delivered to, never listed. */
  projectKind: string | null;
  environmentId: string | null;
  directory: string;
  status: string;
  podIp: string | null;
}

export interface DeliveryStateRow {
  projectEnvironmentId: string;
  converged: boolean;
  pendingSkills: string[];
  omittedSkills: string[];
  attempt: number;
  failedAt: Date | null;
  error: string | null;
}

export interface DeliveryStateWrite {
  converged: boolean;
  pendingSkills: string[];
  omittedSkills: string[];
  attempt: number;
  failedAt: Date | null;
  error: string | null;
}

const UNREACHABLE_STATUSES = new Set<string>([ProjectStatus.Pending, ProjectStatus.Claiming]);

@Injectable()
export class SkillDeliveryRepository {
  /** Every ProjectEnvironment of a Built-in Agent in one Organization — the fan-out's targets. */
  async fanOutTargets(agentId: string, tenantId: string): Promise<FanOutTarget[]> {
    const rows = await db
      .select({
        projectEnvironmentId: projectEnvironments.id,
        projectId: projects.id,
        projectTitle: projects.title,
        projectKind: projects.kind,
        environmentId: projectEnvironments.environmentId,
        directory: projectEnvironments.directory,
        status: projectEnvironments.status,
        podIp: projectEnvironments.podIp,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(and(eq(projects.agentId, agentId), eq(projects.tenantId, tenantId)))
      .orderBy(asc(projects.id), asc(projectEnvironments.id));
    return rows.filter((row) => !UNREACHABLE_STATUSES.has(row.status));
  }

  async target(projectEnvironmentId: string): Promise<FanOutTarget | undefined> {
    const [row] = await db
      .select({
        projectEnvironmentId: projectEnvironments.id,
        projectId: projects.id,
        projectTitle: projects.title,
        projectKind: projects.kind,
        environmentId: projectEnvironments.environmentId,
        directory: projectEnvironments.directory,
        status: projectEnvironments.status,
        podIp: projectEnvironments.podIp,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(eq(projectEnvironments.id, projectEnvironmentId))
      .limit(1);
    return row;
  }

  async agentOf(projectEnvironmentId: string): Promise<{ id: string; name: string; origin: string } | undefined> {
    const [row] = await db
      .select({ id: agents.id, name: agents.name, origin: agents.origin })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .innerJoin(agents, eq(agents.id, projects.agentId))
      .where(eq(projectEnvironments.id, projectEnvironmentId))
      .limit(1);
    return row;
  }

  async agent(agentId: string): Promise<{ id: string; name: string; origin: string } | undefined> {
    const [row] = await db
      .select({ id: agents.id, name: agents.name, origin: agents.origin })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row;
  }

  async hasRunningAgentUpdate(projectEnvironmentId: string, exceptUpdateId?: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - AGENT_UPDATE_STALE_AFTER_MS);
    const [row] = await db
      .select({ id: projectAgentUpdates.id })
      .from(projectAgentUpdates)
      .where(
        and(
          eq(projectAgentUpdates.projectEnvironmentId, projectEnvironmentId),
          eq(projectAgentUpdates.status, AgentUpdateStatus.Running),
          or(isNull(projectAgentUpdates.startedAt), gt(projectAgentUpdates.startedAt, cutoff)),
          ...(exceptUpdateId ? [ne(projectAgentUpdates.id, exceptUpdateId)] : [])
        )
      )
      .limit(1);
    return row !== undefined;
  }

  async deleteDelivery(projectEnvironmentId: string, skillName: string): Promise<void> {
    await db
      .delete(projectSkillDeliveries)
      .where(
        and(
          eq(projectSkillDeliveries.projectEnvironmentId, projectEnvironmentId),
          eq(projectSkillDeliveries.skillName, skillName)
        )
      );
  }

  async writeState(projectEnvironmentId: string, state: DeliveryStateWrite): Promise<void> {
    await db
      .insert(projectSkillDeliveryState)
      .values({ projectEnvironmentId, ...state, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: projectSkillDeliveryState.projectEnvironmentId,
        set: { ...state, updatedAt: new Date() },
      });
  }

  async state(projectEnvironmentId: string): Promise<DeliveryStateRow | undefined> {
    const [row] = await this.statesFor([projectEnvironmentId]);
    return row;
  }

  async statesFor(projectEnvironmentIds: string[]): Promise<DeliveryStateRow[]> {
    if (projectEnvironmentIds.length === 0) return [];
    return db
      .select({
        projectEnvironmentId: projectSkillDeliveryState.projectEnvironmentId,
        converged: projectSkillDeliveryState.converged,
        pendingSkills: projectSkillDeliveryState.pendingSkills,
        omittedSkills: projectSkillDeliveryState.omittedSkills,
        attempt: projectSkillDeliveryState.attempt,
        failedAt: projectSkillDeliveryState.failedAt,
        error: projectSkillDeliveryState.error,
      })
      .from(projectSkillDeliveryState)
      .where(inArray(projectSkillDeliveryState.projectEnvironmentId, projectEnvironmentIds));
  }
}
