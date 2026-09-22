import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  agentProfiles,
  agentProfileSkills,
  agents,
  projectEnvironments,
  projects,
  projectSkillDeliveryState,
  skills,
  skillVersionFiles,
  skillVersions,
  users,
} from '../../db/schema';
import { visibleAgentsWhere } from '../agent/agent-visibility';
import type { SkillTree } from './gate';
import { isTextFile } from './gate/skill-tree';
import { visibleSkillsWhere, type SkillRow } from './skill-visibility';
import { catalogFilterWhere, catalogSearchWhere, type CatalogColumns } from './catalog-filters';
import type { SkillListFilter } from './skill.types';

const SKILL_CATALOG_COLUMNS: CatalogColumns = {
  tenantId: skills.tenantId,
  name: skills.name,
  displayName: skills.displayName,
  description: skills.description,
  origin: skills.origin,
  visibility: skills.visibility,
  archived: skills.archived,
};

export type SkillVersionRow = typeof skillVersions.$inferSelect;
export type SkillVersionFileRow = typeof skillVersionFiles.$inferSelect;

export interface SkillListRow {
  skill: SkillRow;
  latestVersion: SkillVersionRow | null;
  createdByName: string | null;
  usedByAgentCount: number;
  outdatedAgentCount: number;
}

/** One row per (agent, pinned version): the caller groups it by agent. */
export interface SkillAgentPinRow {
  id: string;
  name: string;
  displayName: string | null;
  versionId: string;
  version: number;
}

export interface MintedVersion {
  versionId: string;
  version: number;
}

const MINT_LOCK_NAMESPACE = 'skill-version-mint:';

@Injectable()
export class SkillRepository {
  async list(
    tenantId: string,
    userId: string,
    filter: SkillListFilter,
    query: string | undefined
  ): Promise<SkillListRow[]> {
    const rows = await db
      .select({
        skill: skills,
        latestVersion: skillVersions,
        createdByName: createdByName(),
        usedByAgentCount: usedByAgentCount(),
        outdatedAgentCount: outdatedAgentCount(),
      })
      .from(skills)
      .leftJoin(skillVersions, eq(skillVersions.id, skills.latestVersionId))
      .leftJoin(users, eq(users.id, skills.createdBy))
      .where(
        and(
          visibleSkillsWhere(tenantId, userId, { includeArchived: true }),
          catalogFilterWhere(SKILL_CATALOG_COLUMNS, filter),
          catalogSearchWhere(SKILL_CATALOG_COLUMNS, query)
        )
      )
      .orderBy(asc(skills.name));

    return rows.map((row) => ({
      skill: row.skill,
      latestVersion: row.latestVersion,
      createdByName: row.createdByName,
      usedByAgentCount: Number(row.usedByAgentCount),
      outdatedAgentCount: Number(row.outdatedAgentCount),
    }));
  }

  async findOne(skillId: string): Promise<SkillListRow | undefined> {
    const [row] = await db
      .select({
        skill: skills,
        latestVersion: skillVersions,
        createdByName: createdByName(),
        usedByAgentCount: usedByAgentCount(),
        outdatedAgentCount: outdatedAgentCount(),
      })
      .from(skills)
      .leftJoin(skillVersions, eq(skillVersions.id, skills.latestVersionId))
      .leftJoin(users, eq(users.id, skills.createdBy))
      .where(eq(skills.id, skillId))
      .limit(1);
    if (!row) return undefined;
    return {
      skill: row.skill,
      latestVersion: row.latestVersion,
      createdByName: row.createdByName,
      usedByAgentCount: Number(row.usedByAgentCount),
      outdatedAgentCount: Number(row.outdatedAgentCount),
    };
  }

  listVersions(skillId: string): Promise<SkillVersionRow[]> {
    return db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.version));
  }

  async findVersion(skillId: string, version: number): Promise<SkillVersionRow | undefined> {
    const [row] = await db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
      .limit(1);
    return row;
  }

  listFiles(versionId: string): Promise<SkillVersionFileRow[]> {
    return db
      .select()
      .from(skillVersionFiles)
      .where(eq(skillVersionFiles.versionId, versionId))
      .orderBy(asc(skillVersionFiles.path));
  }

  async readTree(versionId: string): Promise<SkillTree> {
    const files = await this.listFiles(versionId);
    return files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content),
      executable: file.isExecutable,
    }));
  }

  async nameTaken(tenantId: string, name: string): Promise<boolean> {
    const [row] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.name, name), or(eq(skills.tenantId, tenantId), isNull(skills.tenantId))))
      .limit(1);
    return row !== undefined;
  }

  async findByName(tenantId: string, name: string): Promise<SkillRow | undefined> {
    const [row] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.name, name), eq(skills.tenantId, tenantId)))
      .limit(1);
    return row;
  }

  agentsUsing(skillId: string): Promise<{ id: string; displayName: string }[]> {
    return db
      .selectDistinct({ id: agents.id, displayName: sql<string>`coalesce(${agents.displayName}, ${agents.name})` })
      .from(agentProfileSkills)
      .innerJoin(agentProfiles, eq(agentProfiles.id, agentProfileSkills.profileId))
      .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
      .where(eq(agentProfileSkills.skillId, skillId))
      .orderBy(asc(sql`coalesce(${agents.displayName}, ${agents.name})`));
  }

  agentPins(skillId: string, tenantId: string, userId: string): Promise<SkillAgentPinRow[]> {
    return db
      .selectDistinct({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        versionId: agentProfileSkills.skillVersionId,
        version: skillVersions.version,
      })
      .from(agentProfileSkills)
      .innerJoin(agentProfiles, eq(agentProfiles.id, agentProfileSkills.profileId))
      .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
      .innerJoin(skillVersions, eq(skillVersions.id, agentProfileSkills.skillVersionId))
      .where(
        and(eq(agentProfileSkills.skillId, skillId), visibleAgentsWhere(tenantId, userId, { includeArchived: true }))
      )
      .orderBy(asc(agents.name), asc(skillVersions.version));
  }

  async omissionCountsByAgent(skillName: string, tenantId: string): Promise<Map<string, number>> {
    const rows = await db
      .select({ agentId: projects.agentId, omittedIn: sql<number>`count(*)::int` })
      .from(projectSkillDeliveryState)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projectSkillDeliveryState.projectEnvironmentId))
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(
        and(
          eq(projects.tenantId, tenantId),
          isNull(projects.kind),
          sql`${projectSkillDeliveryState.omittedSkills} @> ${JSON.stringify([skillName])}::jsonb`
        )
      )
      .groupBy(projects.agentId);
    return new Map(rows.map((row) => [row.agentId, row.omittedIn]));
  }

  async updateSkill(skillId: string, patch: Partial<typeof skills.$inferInsert>): Promise<void> {
    await db
      .update(skills)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(skills.id, skillId));
  }

  async deleteSkill(skillId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.update(skills).set({ latestVersionId: null }).where(eq(skills.id, skillId));
      await tx.delete(skills).where(eq(skills.id, skillId));
    });
  }

  async createSkillWithFirstVersion(input: {
    tenantId: string;
    userId: string;
    name: string;
    displayName: string | null;
    description: string | null;
    tree: SkillTree;
    contentHash: string;
    flags: typeof skillVersions.$inferInsert.flags;
    lints: string[];
    createdVia: string;
    sourceRef: string | null;
    createdInChatProjectId: string | null;
  }): Promise<{ skillId: string; version: number }> {
    const skillId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(skills).values({
        id: skillId,
        tenantId: input.tenantId,
        origin: 'custom',
        visibility: 'private',
        name: input.name,
        displayName: input.displayName,
        description: input.description,
        createdBy: input.userId,
        createdInChatProjectId: input.createdInChatProjectId,
      });
      const versionId = await insertVersion(tx, {
        skillId,
        version: 1,
        description: input.description,
        contentHash: input.contentHash,
        flags: input.flags,
        lints: input.lints,
        createdVia: input.createdVia,
        sourceRef: input.sourceRef,
        createdBy: input.userId,
        tree: input.tree,
      });
      await tx.update(skills).set({ latestVersionId: versionId, updatedAt: new Date() }).where(eq(skills.id, skillId));
    });
    return { skillId, version: 1 };
  }

  async mintNextVersion(input: {
    skillId: string;
    userId: string;
    description: string | null;
    tree: SkillTree;
    contentHash: string;
    flags: typeof skillVersions.$inferInsert.flags;
    lints: string[];
    createdVia: string;
    sourceRef: string | null;
  }): Promise<MintedVersion> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${MINT_LOCK_NAMESPACE}${input.skillId}`}))`);

      const [{ highest }] = await tx
        .select({ highest: sql<number>`coalesce(max(${skillVersions.version}), 0)` })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, input.skillId));
      const version = Number(highest) + 1;

      const versionId = await insertVersion(tx, {
        skillId: input.skillId,
        version,
        description: input.description,
        contentHash: input.contentHash,
        flags: input.flags,
        lints: input.lints,
        createdVia: input.createdVia,
        sourceRef: input.sourceRef,
        createdBy: input.userId,
        tree: input.tree,
      });

      await tx
        .update(skills)
        .set({ latestVersionId: versionId, description: input.description, updatedAt: new Date() })
        .where(eq(skills.id, input.skillId));

      return { versionId, version };
    });
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertVersion(
  tx: Transaction,
  input: {
    skillId: string;
    version: number;
    description: string | null;
    contentHash: string;
    flags: typeof skillVersions.$inferInsert.flags;
    lints: string[];
    createdVia: string;
    sourceRef: string | null;
    createdBy: string;
    tree: SkillTree;
  }
): Promise<string> {
  const versionId = crypto.randomUUID();
  await tx.insert(skillVersions).values({
    id: versionId,
    skillId: input.skillId,
    version: input.version,
    description: input.description,
    contentHash: input.contentHash,
    flags: input.flags,
    lints: input.lints,
    createdVia: input.createdVia,
    sourceRef: input.sourceRef,
    createdBy: input.createdBy,
  });

  if (input.tree.length > 0) {
    await tx.insert(skillVersionFiles).values(
      input.tree.map((file) => ({
        id: crypto.randomUUID(),
        versionId,
        path: file.path,
        content: file.content,
        size: file.content.byteLength,
        isBinary: !isTextFile(file.content),
        isExecutable: file.executable,
      }))
    );
  }

  return versionId;
}

function usedByAgentCount(): SQL<number> {
  return sql<number>`(
    select count(distinct ${agentProfiles.agentId})
    from ${agentProfileSkills}
    inner join ${agentProfiles} on ${agentProfiles.id} = ${agentProfileSkills.profileId}
    where ${agentProfileSkills.skillId} = ${skills.id}
  )`;
}

function outdatedAgentCount(): SQL<number> {
  return sql<number>`(
    select count(distinct ${agentProfiles.agentId})
    from ${agentProfileSkills}
    inner join ${agentProfiles} on ${agentProfiles.id} = ${agentProfileSkills.profileId}
    where ${agentProfileSkills.skillId} = ${skills.id}
      and ${agentProfileSkills.skillVersionId} is distinct from ${skills.latestVersionId}
  )`;
}

function createdByName(): SQL<string | null> {
  return sql<string | null>`coalesce(${users.displayName}, ${users.email})`;
}
