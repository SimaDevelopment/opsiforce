import { and, eq, isNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { projects, tenantSettings, workspaceMembers, workspaces } from '../../db/schema';

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
      or(isNull(projects.workspaceId), sql`${workspaceMembers.workspaceId} is not null`),
      notInDisabledPrivateWorkspace()
    ),
  };
}

export async function isProjectVisible(tenantId: string, userId: string, projectId: string): Promise<boolean> {
  const visible = visibleProjectsFilter(tenantId, userId);
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(workspaceMembers, visible.workspaceMemberJoin)
    .where(and(visible.where, eq(projects.id, projectId)))
    .limit(1);

  return row !== undefined;
}
