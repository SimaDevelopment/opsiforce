import { and, eq, exists, isNotNull, isNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db';
import { projects, tenantSettings, workspaceMembers, workspaces } from '../../db/schema';
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

function governingChatIsPublic(): SQL {
  const chat = alias(projects, 'governing_chat');
  return exists(
    db
      .select({ one: sql`1` })
      .from(chat)
      .where(and(eq(chat.id, governingChatId()), eq(chat.chatVisibility, 'public')))
  );
}

export function reachableHiddenProjectsWhere(tenantId: string, userId: string): SQL | undefined {
  return and(
    eq(projects.tenantId, tenantId),
    isNotNull(projects.kind),
    or(eq(projects.createdBy, userId), governingChatIsPublic())
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
