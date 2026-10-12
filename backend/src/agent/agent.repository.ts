import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, TransactionRollbackError, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  agentProfileSkills,
  agentProfiles,
  agentSettings,
  agents,
  environments,
  projects,
  skillVersions,
  skills,
  tenantDisabledAgents,
} from '../../db/schema';
import { TEST_PROJECT_KIND } from '../project/project.types';
import type { AgentProfileRow } from '../store/agent-profile.repository';
import { agentColumnsIn, tenantStartableAgentsWhere } from './agent-visibility';

const STARTABLE_AGENT_LOCK = 'startable-agent:';
import type { AgentProfileSkillResponse, AgentRow, AgentSettingsResponse, ShippedSkillResponse } from './agent.types';

export type AgentSettingsRow = typeof agentSettings.$inferSelect;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

@Injectable()
export class AgentRepository {
  async list(tenantId: string, where: SQL | undefined): Promise<AgentRow[]> {
    return db.select(agentColumnsIn(tenantId)).from(agents).where(where).orderBy(asc(agents.name));
  }

  async profileEnvironmentIds(agentIds: string[], tenantId: string): Promise<Map<string, string[]>> {
    const byAgent = new Map<string, string[]>(agentIds.map((id) => [id, []]));
    if (agentIds.length === 0) return byAgent;

    const rows = await db
      .select({ agentId: agentProfiles.agentId, environmentId: agentProfiles.environmentId })
      .from(agentProfiles)
      .innerJoin(environments, eq(environments.id, agentProfiles.environmentId))
      .where(and(inArray(agentProfiles.agentId, agentIds), eq(environments.tenantId, tenantId)))
      .orderBy(desc(environments.isDefault), asc(environments.name));

    for (const row of rows) byAgent.get(row.agentId)?.push(row.environmentId);
    return byAgent;
  }

  async defaultEnvironmentIds(agentIds: string[]): Promise<Map<string, string | null>> {
    const byAgent = new Map<string, string | null>(agentIds.map((id) => [id, null]));
    if (agentIds.length === 0) return byAgent;

    const rows = await db
      .select({ agentId: agentSettings.agentId, environmentId: agentSettings.defaultEnvironmentId })
      .from(agentSettings)
      .where(inArray(agentSettings.agentId, agentIds));

    for (const row of rows) byAgent.set(row.agentId, row.environmentId);
    return byAgent;
  }

  async liveIds(where: SQL | undefined): Promise<Set<string>> {
    const rows = await db.select({ id: agents.id }).from(agents).where(where);
    return new Set(rows.map((row) => row.id));
  }

  async settings(agentId: string): Promise<AgentSettingsResponse> {
    const [row] = await db.select().from(agentSettings).where(eq(agentSettings.agentId, agentId)).limit(1);
    return { defaultEnvironmentId: row?.defaultEnvironmentId ?? null };
  }

  async projectCount(agentId: string, tenantId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.agentId, agentId), eq(projects.tenantId, tenantId), isNull(projects.kind)));
    return Number(row?.count ?? 0);
  }

  async shippedSkills(names: Set<string>): Promise<ShippedSkillResponse[]> {
    const found =
      names.size === 0
        ? []
        : await db
            .select({
              skillId: skills.id,
              name: skills.name,
              displayName: skills.displayName,
              version: skillVersions.version,
            })
            .from(skills)
            .leftJoin(skillVersions, eq(skillVersions.id, skills.latestVersionId))
            .where(and(isNull(skills.tenantId), inArray(skills.name, [...names])));
    const byName = new Map(found.map((row) => [row.name, row]));
    return [...names]
      .toSorted()
      .map((name) => byName.get(name) ?? { skillId: null, name, displayName: null, version: null });
  }

  async enableIn(tenantId: string, agentId: string): Promise<void> {
    await db
      .delete(tenantDisabledAgents)
      .where(and(eq(tenantDisabledAgents.tenantId, tenantId), eq(tenantDisabledAgents.agentId, agentId)));
  }

  async disableUnlessLast(tenantId: string, agentId: string, userId: string): Promise<boolean> {
    return this.keepingOneStartableAgent(tenantId, async (tx) => {
      await tx.insert(tenantDisabledAgents).values({ tenantId, agentId, disabledBy: userId }).onConflictDoNothing();
    });
  }

  async writeSettingsUnlessLast(
    tenantId: string,
    agentId: string,
    patch: Partial<typeof agentSettings.$inferInsert>
  ): Promise<boolean> {
    return this.keepingOneStartableAgent(tenantId, async (tx) => {
      await tx
        .insert(agentSettings)
        .values({ agentId, ...patch })
        .onConflictDoUpdate({ target: agentSettings.agentId, set: { ...patch, updatedAt: new Date() } });
    });
  }

  private async keepingOneStartableAgent(
    tenantId: string,
    write: (tx: Transaction) => Promise<void>
  ): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${STARTABLE_AGENT_LOCK}${tenantId}`}))`);
        await write(tx);
        const [startable] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(tenantStartableAgentsWhere(tenantId))
          .limit(1);
        if (!startable) tx.rollback();
        return true;
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) return false;
      throw error;
    }
  }

  async testProjectIds(agentId: string, tenantId: string): Promise<string[]> {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.agentId, agentId), eq(projects.tenantId, tenantId), eq(projects.kind, TEST_PROJECT_KIND)));
    return rows.map((row) => row.id);
  }

  async publishedBeyondDevelopment(agentId: string, tenantId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .innerJoin(environments, eq(environments.id, agentProfiles.environmentId))
      .where(
        and(eq(agentProfiles.agentId, agentId), eq(environments.tenantId, tenantId), eq(environments.isDefault, false))
      )
      .limit(1);
    return row !== undefined;
  }

  async environmentIds(tenantId: string): Promise<string[]> {
    const rows = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.tenantId, tenantId))
      .orderBy(desc(environments.isDefault), asc(environments.name));
    return rows.map((row) => row.id);
  }

  async profiles(agentId: string, tenantId: string): Promise<AgentProfileRow[]> {
    const rows = await db
      .select({ profile: agentProfiles })
      .from(agentProfiles)
      .innerJoin(environments, eq(environments.id, agentProfiles.environmentId))
      .where(and(eq(agentProfiles.agentId, agentId), eq(environments.tenantId, tenantId)));
    return rows.map((row) => row.profile);
  }

  async profileAt(agentId: string, environmentId: string): Promise<AgentProfileRow | undefined> {
    const [row] = await db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, environmentId)))
      .limit(1);
    return row;
  }

  async skillsOf(profileIds: string[]): Promise<Map<string, AgentProfileSkillResponse[]>> {
    const byProfile = new Map<string, AgentProfileSkillResponse[]>(profileIds.map((id) => [id, []]));
    if (profileIds.length === 0) return byProfile;

    const rows = await db
      .select({
        profileId: agentProfileSkills.profileId,
        skillId: skills.id,
        name: skills.name,
        displayName: skills.displayName,
        visibility: skills.visibility,
        externalServiceId: skills.externalServiceId,
        latestVersionId: skills.latestVersionId,
        retiredAt: skills.retiredAt,
        pinnedVersionId: agentProfileSkills.skillVersionId,
        serviceSettings: agentProfileSkills.serviceSettings,
        pinnedVersion: skillVersions.version,
        flags: skillVersions.flags,
        latestVersion: sql<number | null>`(
          select ${skillVersions.version} from ${skillVersions}
          where ${skillVersions.id} = ${skills.latestVersionId}
        )`,
      })
      .from(agentProfileSkills)
      .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
      .innerJoin(skillVersions, eq(skillVersions.id, agentProfileSkills.skillVersionId))
      .where(inArray(agentProfileSkills.profileId, profileIds))
      .orderBy(asc(skills.name));

    for (const row of rows) {
      byProfile.get(row.profileId)?.push({
        skillId: row.skillId,
        name: row.name,
        displayName: row.displayName,
        pinnedVersionId: row.pinnedVersionId,
        pinnedVersion: row.pinnedVersion,
        latestVersion: row.latestVersion === null ? null : Number(row.latestVersion),
        updateAvailable:
          row.retiredAt === null && row.latestVersionId !== null && row.latestVersionId !== row.pinnedVersionId,
        retired: row.retiredAt !== null,
        visibility: row.visibility,
        flags: row.flags,
        externalServiceId: row.externalServiceId,
        serviceSettings: row.serviceSettings,
      });
    }
    return byProfile;
  }

  async carriedSkillNames(profileId: string): Promise<Map<string, string>> {
    const rows = await db
      .select({ skillId: skills.id, name: skills.name })
      .from(agentProfileSkills)
      .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
      .where(eq(agentProfileSkills.profileId, profileId));
    return new Map(rows.map((row) => [row.name, row.skillId]));
  }

  async privateSkillNames(profileId: string): Promise<string[]> {
    const rows = await db
      .select({ name: skills.name })
      .from(agentProfileSkills)
      .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
      .where(and(eq(agentProfileSkills.profileId, profileId), eq(skills.visibility, 'private')));
    return rows.map((row) => row.name);
  }

  async nameTaken(tenantId: string, name: string): Promise<boolean> {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.name, name)))
      .limit(1);
    return row !== undefined;
  }

  /** What each of this Agent's ProjectEnvironments in one Organization has actually received. */
  async agentsReferencing(environmentId: string): Promise<{ id: string; displayName: string }[]> {
    const rows = await db
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(
        sql`exists (
          select 1 from ${agentProfiles}
          where ${agentProfiles.agentId} = ${agents.id} and ${agentProfiles.environmentId} = ${environmentId}
        ) or exists (
          select 1 from ${agentSettings}
          where ${agentSettings.agentId} = ${agents.id} and ${agentSettings.defaultEnvironmentId} = ${environmentId}
        )`
      )
      .orderBy(asc(agents.name));
    return rows.map((row) => ({ id: row.id, displayName: row.displayName ?? row.name }));
  }
}
