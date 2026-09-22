import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  agentProfileSkills,
  agentProfiles,
  agentSettings,
  agents,
  environments,
  projectEnvironments,
  projectSkillDeliveries,
  projects,
  skillVersions,
  skills,
} from '../../db/schema';

export interface DeliveryTarget {
  projectEnvironmentId: string;
  directory: string;
  tenantId: string | null;
  agentId: string;
  agentName: string;
  agentOrigin: string;
  importedAgent: string | null;
}

export interface PinnedSkill {
  name: string;
  skillVersionId: string;
  contentHash: string;
}

export interface DeliveredSkill {
  skillName: string;
  skillVersionId: string | null;
  contentHash: string;
}

@Injectable()
export class DeliveryRepository {
  async target(projectEnvironmentId: string): Promise<DeliveryTarget | undefined> {
    const [row] = await db
      .select({
        projectEnvironmentId: projectEnvironments.id,
        directory: projectEnvironments.directory,
        tenantId: projects.tenantId,
        agentId: projects.agentId,
        agentName: agents.name,
        agentOrigin: agents.origin,
        importedAgent: projects.importedAgent,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .innerJoin(agents, eq(agents.id, projects.agentId))
      .where(eq(projectEnvironments.id, projectEnvironmentId))
      .limit(1);
    return row;
  }

  /** The Environment a Custom Agent's behaviour is read from — its Default environment (Agent). */
  async defaultEnvironmentId(agentId: string, tenantId: string): Promise<string | undefined> {
    const [settings] = await db
      .select({ environmentId: agentSettings.defaultEnvironmentId })
      .from(agentSettings)
      .where(eq(agentSettings.agentId, agentId))
      .limit(1);
    if (settings?.environmentId) return settings.environmentId;
    return this.developmentEnvironmentId(tenantId);
  }

  async developmentEnvironmentId(tenantId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, true)))
      .limit(1);
    return row?.id;
  }

  async profile(
    agentId: string,
    environmentId: string
  ): Promise<{ id: string; promptBody: string | null; model: string | null; variant: string | null } | undefined> {
    const [row] = await db
      .select({
        id: agentProfiles.id,
        promptBody: agentProfiles.promptBody,
        model: agentProfiles.model,
        variant: agentProfiles.variant,
      })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, environmentId)))
      .limit(1);
    return row;
  }

  async pinnedSkills(profileId: string): Promise<PinnedSkill[]> {
    return db
      .select({
        name: skills.name,
        skillVersionId: agentProfileSkills.skillVersionId,
        contentHash: skillVersions.contentHash,
      })
      .from(agentProfileSkills)
      .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
      .innerJoin(skillVersions, eq(skillVersions.id, agentProfileSkills.skillVersionId))
      .where(eq(agentProfileSkills.profileId, profileId));
  }

  async recordDeliveries(projectEnvironmentId: string, delivered: DeliveredSkill[]): Promise<void> {
    for (const skill of delivered) {
      await db
        .insert(projectSkillDeliveries)
        .values({ projectEnvironmentId, ...skill })
        .onConflictDoUpdate({
          target: [projectSkillDeliveries.projectEnvironmentId, projectSkillDeliveries.skillName],
          set: { skillVersionId: skill.skillVersionId, contentHash: skill.contentHash, deliveredAt: new Date() },
        });
    }
  }

  async delivered(projectEnvironmentId: string): Promise<DeliveredSkill[]> {
    return db
      .select({
        skillName: projectSkillDeliveries.skillName,
        skillVersionId: projectSkillDeliveries.skillVersionId,
        contentHash: projectSkillDeliveries.contentHash,
      })
      .from(projectSkillDeliveries)
      .where(eq(projectSkillDeliveries.projectEnvironmentId, projectEnvironmentId));
  }
}
