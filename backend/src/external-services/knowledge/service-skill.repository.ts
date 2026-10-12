import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db';
import {
  agentProfileSkills,
  agentProfiles,
  environments,
  externalServiceProjectConfigs,
  externalServices,
  projectEnvironments,
  projectEnvironmentSkillsOff,
  projectSkillDeliveries,
  projects,
  skills,
  skillVersions,
  type AgentServiceSettings,
} from '../../../db/schema';
import { SERVICE_SKILL_PREFIX } from '../../delivery/service-skill-source';
import { ProjectStatus, TEST_PROJECT_KIND } from '../../project/project.types';
import type { DbExecutor } from '../../common/locks';

export interface MarkedSkill {
  skillId: string;
  externalServiceId: string;
  name: string;
  skillVersionId: string;
  contentHash: string;
  description: string | null;
}

const UNREACHABLE_STATUSES = [ProjectStatus.Pending, ProjectStatus.Claiming];

export async function profileIdAt(agentId: string, environmentId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, environmentId)))
    .limit(1);
  return row?.id;
}

export async function servicesCarriedBy(profileId: string): Promise<string[]> {
  const rows = await db
    .select({ externalServiceId: skills.externalServiceId })
    .from(agentProfileSkills)
    .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
    .where(and(eq(agentProfileSkills.profileId, profileId), isNotNull(skills.externalServiceId)));
  return rows.flatMap((row) => (row.externalServiceId ? [row.externalServiceId] : []));
}

export interface CarriedServiceSettings {
  externalServiceId: string;
  serviceSettings: AgentServiceSettings;
}

export async function serviceSettingsCarriedBy(profileId: string): Promise<CarriedServiceSettings[]> {
  const rows = await db
    .select({ externalServiceId: skills.externalServiceId, serviceSettings: agentProfileSkills.serviceSettings })
    .from(agentProfileSkills)
    .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
    .where(
      and(
        eq(agentProfileSkills.profileId, profileId),
        isNotNull(skills.externalServiceId),
        isNotNull(agentProfileSkills.serviceSettings)
      )
    );
  return rows.flatMap(({ externalServiceId, serviceSettings }) =>
    externalServiceId && serviceSettings ? [{ externalServiceId, serviceSettings }] : []
  );
}

export async function latestMarkedSkills(externalServiceIds: string[]): Promise<MarkedSkill[]> {
  if (externalServiceIds.length === 0) return [];
  const rows = await db
    .select({
      skillId: skills.id,
      externalServiceId: skills.externalServiceId,
      name: skills.name,
      skillVersionId: skillVersions.id,
      contentHash: skillVersions.contentHash,
      description: skillVersions.description,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.id, skills.latestVersionId))
    .where(inArray(skills.externalServiceId, externalServiceIds));
  return rows.flatMap((row) => (row.externalServiceId ? [{ ...row, externalServiceId: row.externalServiceId }] : []));
}

export async function markedSkillOf(externalServiceId: string): Promise<{ id: string; name: string } | undefined> {
  const [row] = await db
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .where(eq(skills.externalServiceId, externalServiceId));
  return row;
}

export async function environmentsReachedBy(externalServiceId: string, skillName: string): Promise<string[]> {
  const carrying = db
    .select({ agentId: agentProfiles.agentId, tenantId: environments.tenantId })
    .from(agentProfileSkills)
    .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
    .innerJoin(agentProfiles, eq(agentProfiles.id, agentProfileSkills.profileId))
    .innerJoin(environments, eq(environments.id, agentProfiles.environmentId))
    .where(eq(skills.externalServiceId, externalServiceId))
    .as('carrying');
  const rows = await db
    .selectDistinct({ id: projectEnvironments.id })
    .from(projectEnvironments)
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .leftJoin(carrying, and(eq(carrying.agentId, projects.agentId), eq(carrying.tenantId, projects.tenantId)))
    .leftJoin(
      externalServiceProjectConfigs,
      and(
        eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironments.id),
        eq(externalServiceProjectConfigs.externalServiceId, externalServiceId)
      )
    )
    .leftJoin(
      projectSkillDeliveries,
      and(
        eq(projectSkillDeliveries.projectEnvironmentId, projectEnvironments.id),
        eq(projectSkillDeliveries.skillName, skillName)
      )
    )
    .where(
      and(
        or(
          isNotNull(carrying.agentId),
          isNotNull(externalServiceProjectConfigs.id),
          isNotNull(projectSkillDeliveries.skillName)
        ),
        notInArray(projectEnvironments.status, UNREACHABLE_STATUSES)
      )
    );
  return rows.map((row) => row.id);
}

export async function stillExisting(projectEnvironmentIds: string[]): Promise<string[]> {
  if (projectEnvironmentIds.length === 0) return [];
  const rows = await db
    .select({ id: projectEnvironments.id })
    .from(projectEnvironments)
    .where(inArray(projectEnvironments.id, projectEnvironmentIds));
  return rows.map((row) => row.id);
}

export async function environmentsBehindTheirServiceSkills(): Promise<string[]> {
  const outdated = await db
    .selectDistinct({ id: projectSkillDeliveries.projectEnvironmentId })
    .from(projectSkillDeliveries)
    .innerJoin(skillVersions, eq(skillVersions.id, projectSkillDeliveries.skillVersionId))
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, projectSkillDeliveries.projectEnvironmentId))
    .where(
      and(
        isNotNull(skills.externalServiceId),
        ne(skills.latestVersionId, projectSkillDeliveries.skillVersionId),
        notInArray(projectEnvironments.status, UNREACHABLE_STATUSES)
      )
    );
  const undelivered = await db
    .selectDistinct({ id: externalServiceProjectConfigs.projectEnvironmentId })
    .from(externalServiceProjectConfigs)
    .innerJoin(skills, eq(skills.externalServiceId, externalServiceProjectConfigs.externalServiceId))
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceProjectConfigs.projectEnvironmentId))
    .leftJoin(
      projectSkillDeliveries,
      and(
        eq(projectSkillDeliveries.projectEnvironmentId, externalServiceProjectConfigs.projectEnvironmentId),
        eq(projectSkillDeliveries.skillName, skills.name)
      )
    )
    .leftJoin(
      projectEnvironmentSkillsOff,
      and(
        eq(projectEnvironmentSkillsOff.projectEnvironmentId, externalServiceProjectConfigs.projectEnvironmentId),
        eq(projectEnvironmentSkillsOff.skillName, skills.name)
      )
    )
    .where(
      and(
        isNull(projectSkillDeliveries.skillName),
        isNull(projectEnvironmentSkillsOff.skillName),
        notInArray(projectEnvironments.status, UNREACHABLE_STATUSES),
        isNotNull(skills.latestVersionId)
      )
    );
  return [...new Set([...outdated, ...undelivered].map((row) => row.id))];
}

export interface DeliveredServiceSkill {
  projectEnvironmentId: string;
  tenantId: string | null;
  testedSlug: string | null;
  skillName: string;
}

export async function deliveredServiceSkills(): Promise<DeliveredServiceSkill[]> {
  const tested = alias(externalServices, 'tested');
  return db
    .select({
      projectEnvironmentId: projectSkillDeliveries.projectEnvironmentId,
      tenantId: projects.tenantId,
      testedSlug: tested.slug,
      skillName: projectSkillDeliveries.skillName,
    })
    .from(projectSkillDeliveries)
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, projectSkillDeliveries.projectEnvironmentId))
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .leftJoin(
      tested,
      and(
        eq(projects.kind, TEST_PROJECT_KIND),
        eq(tested.builderChatId, projects.createdByProjectId),
        eq(tested.tenantId, projects.tenantId)
      )
    )
    .where(
      and(
        sql`starts_with(${projectSkillDeliveries.skillName}, ${SERVICE_SKILL_PREFIX})`,
        notInArray(projectEnvironments.status, UNREACHABLE_STATUSES)
      )
    );
}

export async function movePinsToLatest(skillId: string, skillVersionId: string): Promise<void> {
  await db
    .update(agentProfileSkills)
    .set({ skillVersionId })
    .where(and(eq(agentProfileSkills.skillId, skillId), ne(agentProfileSkills.skillVersionId, skillVersionId)));
}

export async function unpinServiceSkillsOfBuilderChat(tx: DbExecutor, builderChatId: string): Promise<void> {
  await tx
    .delete(agentProfileSkills)
    .where(
      inArray(
        agentProfileSkills.skillId,
        tx
          .select({ id: skills.id })
          .from(skills)
          .innerJoin(externalServices, eq(externalServices.id, skills.externalServiceId))
          .where(eq(externalServices.builderChatId, builderChatId))
      )
    );
}
