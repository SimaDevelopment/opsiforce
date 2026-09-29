import { and, eq, exists, isNotNull, isNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { agents, projects, skills, tenantSettings, workspaceMembers, workspaces } from '../../db/schema';
import { visibleAgentsWhere } from '../agent/agent-visibility';
import { visibleSkillsWhere } from '../store/skill-visibility';
import { TEST_PROJECT_KIND } from './project.types';

export interface ProjectVisibilityFilter {
  workspaceMemberJoin: SQL | undefined;
  where: SQL | undefined;
}

function notInDisabledPrivateWorkspace(): SQL {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(workspaces)
      .innerJoin(tenantSettings, eq(tenantSettings.tenantId, workspaces.tenantId))
      .where(
        and(
          eq(workspaces.id, projects.workspaceId),
          eq(workspaces.type, 'private'),
          eq(tenantSettings.privateWorkspaceEnabled, false)
        )
      )
  );
}

export function visibleProjectsFilter(tenantId: string, userId: string): ProjectVisibilityFilter {
  return {
    workspaceMemberJoin: and(
      eq(workspaceMembers.workspaceId, projects.workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    where: and(
      eq(projects.tenantId, tenantId),
      isNull(projects.kind),
      or(isNull(projects.workspaceId), sql`${workspaceMembers.workspaceId} is not null`),
      notInDisabledPrivateWorkspace()
    ),
  };
}

function governingChatId(): SQL {
  return sql`case when ${projects.kind} = ${TEST_PROJECT_KIND} then ${projects.createdByProjectId} else ${projects.id} end`;
}

function governingChatSubjectVisibleTo(tenantId: string, userId: string): SQL | undefined {
  const visible = { includeDisabled: true };
  const agentSubject = exists(
    db
      .select({ one: sql`1` })
      .from(agents)
      .where(and(eq(agents.builderChatId, governingChatId()), visibleAgentsWhere(tenantId, userId, visible)))
  );
  const skillSubject = exists(
    db
      .select({ one: sql`1` })
      .from(skills)
      .where(and(eq(skills.builderChatId, governingChatId()), visibleSkillsWhere(tenantId, userId, visible)))
  );
  return or(agentSubject, skillSubject);
}

export function reachableHiddenProjectsWhere(tenantId: string, userId: string): SQL | undefined {
  return and(
    eq(projects.tenantId, tenantId),
    isNotNull(projects.kind),
    or(eq(projects.createdBy, userId), governingChatSubjectVisibleTo(tenantId, userId))
  );
}

export function accessibleProjectsFilter(tenantId: string, userId: string): ProjectVisibilityFilter {
  const visible = visibleProjectsFilter(tenantId, userId);
  return {
    workspaceMemberJoin: visible.workspaceMemberJoin,
    where: or(visible.where, reachableHiddenProjectsWhere(tenantId, userId)),
  };
}

/** The one answer to "may this user reach this kind-stamped Project?", asked wherever a row is held. */
export async function isHiddenProjectReachable(tenantId: string, userId: string, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), reachableHiddenProjectsWhere(tenantId, userId)))
    .limit(1);

  return row !== undefined;
}

export async function isProjectAccessible(tenantId: string, userId: string, projectId: string): Promise<boolean> {
  const accessible = accessibleProjectsFilter(tenantId, userId);
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(workspaceMembers, accessible.workspaceMemberJoin)
    .where(and(accessible.where, eq(projects.id, projectId)))
    .limit(1);

  return row !== undefined;
}
