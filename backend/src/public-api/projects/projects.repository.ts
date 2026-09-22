import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db';
import {
  agents,
  environments,
  folders,
  projectApps,
  projectEnvironments,
  projectSettings,
  projects,
  workspaceMembers,
  workspaces,
} from '../../../db/schema';
import { reachableHiddenProjectsWhere, visibleProjectsFilter } from '../../project/project-visibility';
import type { ProjectKind, ProjectStatus } from '../../project/project.types';
import { beforeCursor, cursorValue, takePage, type TakenPage } from '../pagination';
import type { ProjectListQuery } from './projects.schema';

const projectWorkspace = alias(workspaces, 'project_workspace');

const projectFields = {
  id: projects.id,
  title: projects.title,
  description: projects.description,
  disabled: projects.disabled,
  createdBy: projects.createdBy,
  createdByProjectId: projects.createdByProjectId,
  kind: projects.kind,
  importedAgent: projects.importedAgent,
  lastPromptAt: projects.lastPromptAt,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  cursorAt: cursorValue(projects.createdAt),
  timezone: projectSettings.timezone,
  agentId: agents.id,
  agentName: agents.name,
  workspaceId: projectWorkspace.id,
  workspaceName: projectWorkspace.name,
  workspaceType: projectWorkspace.type,
  folderId: folders.id,
  folderName: folders.name,
};

export interface ProjectRow {
  id: string;
  title: string | null;
  description: string | null;
  disabled: boolean;
  createdBy: string | null;
  createdByProjectId: string | null;
  kind: ProjectKind | null;
  importedAgent: string | null;
  lastPromptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cursorAt: string;
  timezone: string;
  agentId: string;
  agentName: string;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceType: 'private' | 'shared' | null;
  folderId: string | null;
  folderName: string | null;
}

export interface EnvironmentRow {
  id: string;
  projectId: string;
  isDefault: boolean;
  status: ProjectStatus;
  lastActiveAt: Date | null;
  sessionId: string | null;
  environmentName: string | null;
  environmentSlug: string | null;
  hasApp: boolean;
  appName: string | null;
}

export interface ProjectScope {
  tenantId: string;
  userId: string;
  createdByProjectId?: string;
}

function createdByCallingProject(scope: ProjectScope) {
  return scope.createdByProjectId === undefined ? undefined : eq(projects.createdByProjectId, scope.createdByProjectId);
}

@Injectable()
export class PublicProjectsRepository {
  async page(scope: ProjectScope, query: ProjectListQuery): Promise<TakenPage<ProjectRow>> {
    const visible = visibleProjectsFilter(scope.tenantId, scope.userId);
    const rows = await this.baseQuery()
      .leftJoin(workspaceMembers, visible.workspaceMemberJoin)
      .where(
        and(
          visible.where,
          query.workspaceId === undefined ? undefined : eq(projects.workspaceId, query.workspaceId),
          query.agentId === undefined ? undefined : eq(projects.agentId, query.agentId),
          createdByCallingProject(scope),
          beforeCursor(projects.createdAt, projects.id, query.cursor)
        )
      )
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(query.limit + 1);

    return takePage(rows, query.limit);
  }

  async findById(projectId: string): Promise<ProjectRow | null> {
    const [row] = await this.baseQuery().where(eq(projects.id, projectId)).limit(1);
    return row ?? null;
  }

  async findVisible(scope: ProjectScope, projectId: string): Promise<ProjectRow | null> {
    const visible = visibleProjectsFilter(scope.tenantId, scope.userId);
    const [row] = await this.baseQuery()
      .leftJoin(workspaceMembers, visible.workspaceMemberJoin)
      .where(and(visible.where, eq(projects.id, projectId), createdByCallingProject(scope)))
      .limit(1);

    return row ?? null;
  }

  async findReachableHidden(scope: ProjectScope, projectId: string): Promise<ProjectRow | null> {
    const [row] = await this.baseQuery()
      .where(
        and(
          eq(projects.id, projectId),
          reachableHiddenProjectsWhere(scope.tenantId, scope.userId),
          createdByCallingProject(scope)
        )
      )
      .limit(1);

    return row ?? null;
  }

  async environmentsOf(projectIds: string[]): Promise<Map<string, EnvironmentRow[]>> {
    const byProject = new Map<string, EnvironmentRow[]>(projectIds.map((id) => [id, []]));
    if (projectIds.length === 0) return byProject;

    const rows = await db
      .select({
        id: projectEnvironments.id,
        projectId: projectEnvironments.projectId,
        isDefault: projectEnvironments.isDefault,
        status: projectEnvironments.status,
        lastActiveAt: projectEnvironments.lastActiveAt,
        sessionId: projectEnvironments.sessionId,
        environmentName: environments.name,
        environmentSlug: environments.slug,
        hasApp: sql<boolean>`${projectApps.projectEnvironmentId} is not null`.as('has_app'),
        appName: projectApps.name,
      })
      .from(projectEnvironments)
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .leftJoin(projectApps, eq(projectApps.projectEnvironmentId, projectEnvironments.id))
      .where(inArray(projectEnvironments.projectId, projectIds))
      .orderBy(desc(projectEnvironments.isDefault), asc(projectEnvironments.createdAt));

    for (const row of rows) {
      byProject.get(row.projectId)?.push(row);
    }
    return byProject;
  }

  private baseQuery() {
    return db
      .select(projectFields)
      .from(projects)
      .innerJoin(projectSettings, eq(projectSettings.projectId, projects.id))
      .innerJoin(agents, eq(agents.id, projects.agentId))
      .leftJoin(projectWorkspace, eq(projectWorkspace.id, projects.workspaceId))
      .leftJoin(folders, eq(folders.id, projects.folderId));
  }
}
