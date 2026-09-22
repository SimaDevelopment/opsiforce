import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  deletedProjectEnvironments,
  environments,
  projectEnvironments,
  projectSettings,
  projects,
} from '../../db/schema';
import type { ProjectStatus } from '../project/project.types';
import {
  CreateProjectEnvironmentInput,
  ProjectEnvironmentContext,
  ProjectEnvironmentPatch,
  ProjectEnvironmentRow,
} from './project-environment.types';

const contextFields = {
  id: projectEnvironments.id,
  projectId: projectEnvironments.projectId,
  environmentId: projectEnvironments.environmentId,
  isDefault: projectEnvironments.isDefault,
  directory: projectEnvironments.directory,
  status: projectEnvironments.status,
  podIp: projectEnvironments.podIp,
  sessionId: projectEnvironments.sessionId,
  platformVersion: projectEnvironments.platformVersion,
  authMode: projectEnvironments.authMode,
  deployedCommitSha: projectEnvironments.deployedCommitSha,
  lastActiveAt: projectEnvironments.lastActiveAt,
  createdAt: projectEnvironments.createdAt,
  updatedAt: projectEnvironments.updatedAt,
  tenantId: projects.tenantId,
  workspaceId: projects.workspaceId,
  agentId: projects.agentId,
  title: projects.title,
  description: projects.description,
  disabled: projects.disabled,
  bifrostProjectId: projects.bifrostProjectId,
  timeoutIdle: projectSettings.timeoutIdle,
  appTimeoutIdle: projectSettings.appTimeoutIdle,
  timezone: projectSettings.timezone,
  requestLogMode: projectSettings.requestLogMode,
  requestLogBodyLimit: projectSettings.requestLogBodyLimit,
  environmentName: environments.name,
  environmentSlug: environments.slug,
  environmentIsDefault: environments.isDefault,
};

@Injectable()
export class ProjectEnvironmentService {
  private baseQuery() {
    return db
      .select(contextFields)
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .innerJoin(projectSettings, eq(projectSettings.projectId, projectEnvironments.projectId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId));
  }

  private select(where: SQL): Promise<ProjectEnvironmentContext[]> {
    return this.baseQuery().where(where) as Promise<ProjectEnvironmentContext[]>;
  }

  async findByIdOrNull(envId: string): Promise<ProjectEnvironmentContext | null> {
    const [row] = await this.select(eq(projectEnvironments.id, envId));
    return row ?? null;
  }

  async findById(envId: string): Promise<ProjectEnvironmentContext> {
    const row = await this.findByIdOrNull(envId);
    if (!row) throw new NotFoundException(`Project environment ${envId} not found`);
    return row;
  }

  async findRequestedForProject(
    projectId: string,
    environmentId: string | undefined
  ): Promise<ProjectEnvironmentContext | undefined> {
    if (!environmentId || environmentId === projectId) return undefined;
    const env = await this.findById(environmentId);
    if (env.projectId !== projectId) throw new NotFoundException(`Environment ${environmentId} not found`);
    return env;
  }

  defaultEnvironmentId(projectId: string): string {
    return projectId;
  }

  findDefaultByProjectId(projectId: string): Promise<ProjectEnvironmentContext> {
    return this.findById(this.defaultEnvironmentId(projectId));
  }

  findDefaultByProjectIdOrNull(projectId: string): Promise<ProjectEnvironmentContext | null> {
    return this.findByIdOrNull(this.defaultEnvironmentId(projectId));
  }

  listByProjectId(projectId: string): Promise<ProjectEnvironmentContext[]> {
    return this.select(eq(projectEnvironments.projectId, projectId));
  }

  async listIdsByTenant(tenantId: string): Promise<string[]> {
    const rows = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(eq(projects.tenantId, tenantId));

    return rows.map((row) => row.id);
  }

  listByStatus(status: ProjectStatus | ProjectStatus[]): Promise<ProjectEnvironmentContext[]> {
    const where = Array.isArray(status)
      ? inArray(projectEnvironments.status, status)
      : eq(projectEnvironments.status, status);
    return this.select(where);
  }

  async listAllDirectories(): Promise<{ id: string; projectId: string; directory: string }[]> {
    return db
      .select({
        id: projectEnvironments.id,
        projectId: projectEnvironments.projectId,
        directory: projectEnvironments.directory,
      })
      .from(projectEnvironments);
  }

  async create(input: CreateProjectEnvironmentInput): Promise<void> {
    await db.insert(projectEnvironments).values({
      id: input.id,
      projectId: input.projectId,
      environmentId: input.environmentId,
      isDefault: input.isDefault,
      directory: input.directory,
      platformVersion: input.platformVersion,
      status: input.status ?? 'starting',
      authMode: input.authMode ?? 'public',
      deployedCommitSha: input.deployedCommitSha ?? null,
    });
  }

  async patch(
    envId: string,
    patch: ProjectEnvironmentPatch,
    expectStatus?: ProjectStatus | ProjectStatus[]
  ): Promise<ProjectEnvironmentRow | undefined> {
    const where = expectStatus
      ? and(
          eq(projectEnvironments.id, envId),
          Array.isArray(expectStatus)
            ? inArray(projectEnvironments.status, expectStatus)
            : eq(projectEnvironments.status, expectStatus)
        )
      : eq(projectEnvironments.id, envId);

    const [updated] = await db
      .update(projectEnvironments)
      .set({ ...patch, updatedAt: new Date() })
      .where(where)
      .returning();
    return updated;
  }

  async touchActivity(envId: string): Promise<void> {
    const now = new Date();
    await db
      .update(projectEnvironments)
      .set({ lastActiveAt: now, updatedAt: now })
      .where(eq(projectEnvironments.id, envId));
  }

  async bindEnvironment(envId: string, environmentId: string): Promise<void> {
    await db
      .update(projectEnvironments)
      .set({ environmentId, updatedAt: new Date() })
      .where(eq(projectEnvironments.id, envId));
  }

  async delete(env: { id: string; projectId: string; tenantId: string | null; directory: string }): Promise<void> {
    await db
      .insert(deletedProjectEnvironments)
      .values({
        id: env.id,
        projectId: env.projectId,
        tenantId: env.tenantId,
        directory: env.directory,
      })
      .onConflictDoNothing();
    await db.delete(projectEnvironments).where(eq(projectEnvironments.id, env.id));
  }
}
