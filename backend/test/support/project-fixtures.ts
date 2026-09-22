import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, projects, tenantSettings, users, workspaces } from '../../db/schema';
import { EnvironmentService } from '../../src/environment/environment.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectService } from '../../src/project/project.service';
import { ProjectStatus } from '../../src/project/project.types';
import { TenantService } from '../../src/tenant/tenant.service';
import { UserService } from '../../src/user/user.service';
import { WorkspaceService } from '../../src/workspace/workspace.service';
import { organizationName, proxyHeaders, serviceAccountUsername } from './proxy-identity';

export interface OrganizationFixture {
  name: string;
  tenantId: string;
}

export interface MemberFixture {
  keycloakId: string;
  userId: string;
  headers: Record<string, string>;
}

export interface ProjectFixtureOptions {
  title?: string;
  workspaceId?: string | null;
  folderId?: string | null;
  agentId?: string;
}

export async function createOrganization(app: INestApplication): Promise<OrganizationFixture> {
  const name = organizationName();
  const tenant = await app.get(TenantService).getOrCreateTenant(name);
  return { name, tenantId: tenant.id };
}

export async function disablePrivateWorkspaces(organization: OrganizationFixture): Promise<void> {
  await db
    .update(tenantSettings)
    .set({ privateWorkspaceEnabled: false })
    .where(eq(tenantSettings.tenantId, organization.tenantId));
}

export async function addMember(
  app: INestApplication,
  organization: OrganizationFixture,
  permissions?: string[]
): Promise<MemberFixture> {
  const keycloakId = randomUUID();
  const user = await app.get(UserService).getOrCreateUser({ keycloakId }, organization.tenantId);
  return {
    keycloakId,
    userId: user.id,
    headers: proxyHeaders({ userId: keycloakId, organizations: [organization.name], permissions }),
  };
}

export interface ServiceAccountFixture {
  keycloakId: string;
  username: string;
  headers: Record<string, string>;
}

export function addServiceAccount(organization: OrganizationFixture, permissions?: string[]): ServiceAccountFixture {
  const keycloakId = randomUUID();
  const username = serviceAccountUsername();
  return {
    keycloakId,
    username,
    headers: proxyHeaders({ userId: keycloakId, username, organizations: [organization.name], permissions }),
  };
}

export async function createAgent(): Promise<string> {
  const id = randomUUID();
  await db.insert(agents).values({ id, name: `agent-${id.slice(0, 8)}` });
  return id;
}

export interface ProjectPlacementRow {
  workspaceId: string | null;
  workspaceType: 'private' | 'shared' | null;
  workspaceOwnerId: string | null;
  folderId: string | null;
}

export async function placementOf(projectId: string): Promise<ProjectPlacementRow> {
  const [row] = await db
    .select({
      workspaceId: projects.workspaceId,
      workspaceType: workspaces.type,
      workspaceOwnerId: workspaces.ownerId,
      folderId: projects.folderId,
    })
    .from(projects)
    .leftJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(eq(projects.id, projectId));
  if (!row) throw new Error(`No project ${projectId}`);
  return row;
}

export async function privateWorkspaceCountOf(keycloakId: string): Promise<number> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, keycloakId));
  if (!user) return 0;
  const rows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, user.id));
  return rows.length;
}

export async function createSharedWorkspace(
  app: INestApplication,
  organization: OrganizationFixture,
  owner: MemberFixture
): Promise<string> {
  const workspace = await app
    .get(WorkspaceService)
    .create({ name: `ws-${randomUUID().slice(0, 8)}` }, organization.tenantId, owner.userId);
  return workspace.id;
}

export async function privateWorkspaceIdOf(
  app: INestApplication,
  organization: OrganizationFixture,
  member: MemberFixture
): Promise<string> {
  const workspaceService = app.get(WorkspaceService);
  await workspaceService.ensurePrivateWorkspace(member.userId, organization.tenantId);
  const owned = await workspaceService.findAll({ userId: member.userId, tenantId: organization.tenantId });
  const privateWorkspace = owned.find((workspace) => workspace.type === 'private');
  if (!privateWorkspace) throw new Error(`No private workspace for user ${member.userId}`);
  return privateWorkspace.id;
}

export async function createFolder(
  app: INestApplication,
  organization: OrganizationFixture,
  member: MemberFixture,
  workspaceId: string
): Promise<{ id: string; name: string }> {
  const name = `folder-${randomUUID().slice(0, 8)}`;
  const folder = await app.get(WorkspaceService).createFolder({
    workspaceId,
    tenantId: organization.tenantId,
    userId: member.userId,
    canManageWorkspaces: true,
    dto: { name },
  });
  return { id: folder.id, name };
}

export async function createProject(
  app: INestApplication,
  organization: OrganizationFixture,
  options: ProjectFixtureOptions = {}
): Promise<string> {
  const project = await app
    .get(ProjectService)
    .create(
      { title: options.title ?? `project-${randomUUID().slice(0, 8)}`, agentId: options.agentId },
      organization.tenantId,
      options.workspaceId ?? null,
      options.folderId ?? null
    );
  return project.id;
}

export async function disableProject(projectId: string): Promise<void> {
  await db.update(projects).set({ disabled: true }).where(eq(projects.id, projectId));
}

export async function addNamedEnvironment(
  app: INestApplication,
  organization: OrganizationFixture,
  projectId: string,
  name: string
): Promise<string> {
  const environment = await app
    .get(EnvironmentService)
    .create(organization.tenantId, { name, slug: name.toLowerCase() });
  const projectEnvironmentId = randomUUID();
  await app.get(ProjectEnvironmentService).create({
    id: projectEnvironmentId,
    projectId,
    environmentId: environment.id,
    isDefault: false,
    directory: `projects/${projectEnvironmentId}`,
    platformVersion: '0.0.0-test',
    status: ProjectStatus.Publishing,
  });
  return projectEnvironmentId;
}
