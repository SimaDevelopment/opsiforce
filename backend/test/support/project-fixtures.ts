import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { projects, skills, tenantSettings, users, workspaces } from '../../db/schema';
import { DEFAULT_AGENT_NAME } from '../../src/agent/agent.types';
import { ensureBuiltInAgent } from './agent-fixtures';
import { EnvironmentService } from '../../src/environment/environment.service';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectService } from '../../src/project/project.service';
import { ProjectStatus, type ProjectKind } from '../../src/project/project.types';
import { TenantService } from '../../src/tenant/tenant.service';
import { UserService } from '../../src/user/user.service';
import { WorkspaceService } from '../../src/workspace/workspace.service';
import { tenantName, proxyHeaders, serviceAccountUsername } from './proxy-identity';

export interface TenantFixture {
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
  createdBy?: string | null;
  createdByProjectId?: string | null;
}

export async function createTenant(app: INestApplication): Promise<TenantFixture> {
  const name = tenantName();
  const tenant = await app.get(TenantService).getOrCreateTenant(name);
  return { name, tenantId: tenant.id };
}

export async function disablePrivateWorkspaces(tenant: TenantFixture): Promise<void> {
  await db
    .update(tenantSettings)
    .set({ privateWorkspaceEnabled: false })
    .where(eq(tenantSettings.tenantId, tenant.tenantId));
}

export async function addMember(
  app: INestApplication,
  tenant: TenantFixture,
  permissions?: string[]
): Promise<MemberFixture> {
  const keycloakId = randomUUID();
  const headers = proxyHeaders({ userId: keycloakId, tenants: [tenant.name], permissions });
  const user = await app
    .get(UserService)
    .getOrCreateUser({ keycloakId, groups: headers['x-forwarded-groups'] }, tenant.tenantId);
  return { keycloakId, userId: user.id, headers };
}

export async function removeMemberFromTenant(member: MemberFixture): Promise<void> {
  await db.update(users).set({ groups: '' }).where(eq(users.id, member.userId));
}

export async function setMemberPermissions(
  tenant: TenantFixture,
  member: MemberFixture,
  permissions: string[]
): Promise<void> {
  const headers = proxyHeaders({ userId: member.keycloakId, tenants: [tenant.name], permissions });
  await db.update(users).set({ groups: headers['x-forwarded-groups'] }).where(eq(users.id, member.userId));
}

export interface ServiceAccountFixture {
  keycloakId: string;
  username: string;
  headers: Record<string, string>;
}

export function addServiceAccount(tenant: TenantFixture, permissions?: string[]): ServiceAccountFixture {
  const keycloakId = randomUUID();
  const username = serviceAccountUsername();
  return {
    keycloakId,
    username,
    headers: proxyHeaders({ userId: keycloakId, username, tenants: [tenant.name], permissions }),
  };
}

export async function createAgent(): Promise<string> {
  return ensureBuiltInAgent(DEFAULT_AGENT_NAME);
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
  tenant: TenantFixture,
  owner: MemberFixture
): Promise<string> {
  const workspace = await app
    .get(WorkspaceService)
    .create({ name: `ws-${randomUUID().slice(0, 8)}` }, tenant.tenantId, owner.userId);
  return workspace.id;
}

export async function privateWorkspaceIdOf(
  app: INestApplication,
  tenant: TenantFixture,
  member: MemberFixture
): Promise<string> {
  const workspaceService = app.get(WorkspaceService);
  await workspaceService.ensurePrivateWorkspace(member.userId, tenant.tenantId);
  const owned = await workspaceService.findAll({ userId: member.userId, tenantId: tenant.tenantId });
  const privateWorkspace = owned.find((workspace) => workspace.type === 'private');
  if (!privateWorkspace) throw new Error(`No private workspace for user ${member.userId}`);
  return privateWorkspace.id;
}

export async function createFolder(
  app: INestApplication,
  tenant: TenantFixture,
  member: MemberFixture,
  workspaceId: string
): Promise<{ id: string; name: string }> {
  const name = `folder-${randomUUID().slice(0, 8)}`;
  const folder = await app.get(WorkspaceService).createFolder({
    workspaceId,
    tenantId: tenant.tenantId,
    userId: member.userId,
    canManageWorkspaces: true,
    dto: { name },
  });
  return { id: folder.id, name };
}

export async function createProject(
  app: INestApplication,
  tenant: TenantFixture,
  options: ProjectFixtureOptions = {}
): Promise<string> {
  const project = await app
    .get(ProjectService)
    .create(
      { title: options.title ?? `project-${randomUUID().slice(0, 8)}`, agentId: options.agentId },
      tenant.tenantId,
      {
        workspaceId: options.workspaceId,
        folderId: options.folderId,
        createdBy: options.createdBy,
        createdByProjectId: options.createdByProjectId,
      }
    );
  return project.id;
}

export function platformApiKeyFor(
  app: INestApplication,
  tenant: TenantFixture,
  projectId: string
): Promise<string> {
  return app.get(GatewayKeyService).createKey(projectId, projectId, tenant.tenantId, 'platform-api');
}

export function serviceKeyFor(
  app: INestApplication,
  tenant: TenantFixture,
  projectId: string
): Promise<string> {
  return app.get(GatewayKeyService).createKey(projectId, projectId, tenant.tenantId);
}

export async function clearProjectCreator(projectId: string): Promise<void> {
  await db.update(projects).set({ createdBy: null }).where(eq(projects.id, projectId));
}

export async function stampProjectKind(projectId: string, kind: ProjectKind): Promise<void> {
  await db.update(projects).set({ kind }).where(eq(projects.id, projectId));
}

export async function setChatSubjectVisibility(chatId: string, visibility: 'private' | 'public'): Promise<void> {
  const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.builderChatId, chatId));
  if (existing) {
    await db.update(skills).set({ visibility }).where(eq(skills.id, existing.id));
    return;
  }
  const [chat] = await db
    .select({ tenantId: projects.tenantId, createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, chatId));
  const id = randomUUID();
  await db.insert(skills).values({
    id,
    tenantId: chat.tenantId,
    origin: 'custom',
    name: `subject-${id.slice(0, 8)}`,
    visibility,
    createdBy: chat.createdBy,
    builderChatId: chatId,
  });
}

export async function disableProject(projectId: string): Promise<void> {
  await db.update(projects).set({ disabled: true }).where(eq(projects.id, projectId));
}

export async function addNamedEnvironment(
  app: INestApplication,
  tenant: TenantFixture,
  projectId: string,
  name: string
): Promise<string> {
  const environment = await app
    .get(EnvironmentService)
    .create(tenant.tenantId, { name, slug: name.toLowerCase() });
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
