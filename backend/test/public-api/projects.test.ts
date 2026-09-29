import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectStatus } from '../../src/project/project.types';
import { ENVIRONMENT_FIELDS, PROJECT_FIELDS } from './support/dto-fields';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import {
  addMember,
  addNamedEnvironment,
  createFolder,
  createTenant,
  createProject,
  createSharedWorkspace,
  disablePrivateWorkspaces,
  disableProject,
  privateWorkspaceIdOf,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { seedLiveAgent } from '../support/agent-fixtures';

const EXCLUDED_PROJECT_FIELDS = [
  'tenantId',
  'bifrostProjectId',
  'directory',
  'podIp',
  'timeoutIdle',
  'appTimeoutIdle',
  'podClass',
  'cpuMillicores',
  'memoryRequestMib',
  'memoryLimitMib',
  'requestLogMode',
  'requestLogBodyLimit',
  'hasApp',
  'appName',
  'appDescription',
  'status',
  'appUrl',
];

const EXCLUDED_ENVIRONMENT_FIELDS = ['authMode', 'deployedCommitSha', 'directory', 'podIp', 'appUrl'];

interface ProjectBody {
  id: string;
  environments: { id: string; name: string; isDefault: boolean; status: string }[];
}

function ids(items: { id: string }[]): string[] {
  return items.map((item) => item.id);
}

describe('projects read routes', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;

  async function listProjects(member: MemberFixture, query = ''): Promise<ProjectBody[]> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects${query}`, headers: member.headers });
    expect(res.statusCode).toBe(200);
    return res.json().items;
  }

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('the envelope and its cursor', () => {
    let tenant: TenantFixture;
    let member: MemberFixture;
    let created: string[];

    beforeAll(async () => {
      tenant = await createTenant(app);
      member = await addMember(app, tenant);
      created = [];
      for (let index = 0; index < 4; index += 1) {
        created.push(await createProject(app, tenant, { title: `Project ${index}` }));
      }
    });

    it('answers items and nextCursor, newest first', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: member.headers });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body)).toEqual(['items', 'nextCursor']);
      expect(body.nextCursor).toBeNull();
      expect(ids(body.items)).toEqual(created.toReversed());
    });

    it('keeps the next page stable when a newer Project is added', async () => {
      const first = await app.inject({ method: 'GET', url: '/api/v1/projects?limit=2', headers: member.headers });
      const { items, nextCursor } = first.json();
      expect(ids(items)).toEqual([created[3], created[2]]);
      expect(nextCursor).toEqual(expect.any(String));

      await createProject(app, tenant, { title: 'Newer' });

      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/projects?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
        headers: member.headers,
      });
      expect(ids(second.json().items)).toEqual([created[1], created[0]]);
    });

    it('refuses a limit above the maximum', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects?limit=201', headers: member.headers });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:validation-error',
        errors: [expect.objectContaining({ pointer: '#/limit', in: 'query' })],
      });
    });
  });

  describe('the Project it renders', () => {
    let tenant: TenantFixture;
    let member: MemberFixture;
    let workspaceId: string;
    let folder: { id: string; name: string };
    let projectId: string;

    beforeAll(async () => {
      tenant = await createTenant(app);
      member = await addMember(app, tenant);
      workspaceId = await createSharedWorkspace(app, tenant, member);
      folder = await createFolder(app, tenant, member, workspaceId);
      projectId = await createProject(app, tenant, { title: 'Rendered', workspaceId, folderId: folder.id });
    });

    it('carries exactly the documented fields', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: member.headers });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body)).toEqual(PROJECT_FIELDS);
      expect(body).toMatchObject({
        id: projectId,
        title: 'Rendered',
        agent: { id: expect.any(String), name: expect.any(String) },
        workspace: { id: workspaceId, name: expect.any(String), type: 'shared' },
        folder: { id: folder.id, name: folder.name },
        disabled: false,
        timezone: 'UTC',
        agentStatus: 'idle',
        lastPromptAt: null,
      });
      expect(Date.parse(body.createdAt)).not.toBeNaN();
    });

    it('leaves every internal field out', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: member.headers });
      const body = res.json();

      for (const field of EXCLUDED_PROJECT_FIELDS) expect(body).not.toHaveProperty(field);
      for (const field of EXCLUDED_ENVIRONMENT_FIELDS) expect(body.environments[0]).not.toHaveProperty(field);
      expect(Object.keys(body.environments[0])).toEqual(ENVIRONMENT_FIELDS);
    });

    it('reports null workspace for a Public Project', async () => {
      const publicProjectId = await createProject(app, tenant, { title: 'Public' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${publicProjectId}`,
        headers: member.headers,
      });

      expect(res.json()).toMatchObject({ workspace: null, folder: null });
    });

    it('lists every environment, Development first', async () => {
      const staging = await addNamedEnvironment(app, tenant, projectId, `Staging-${randomUUID().slice(0, 6)}`);
      const preview = await addNamedEnvironment(app, tenant, projectId, `Preview-${randomUUID().slice(0, 6)}`);

      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: member.headers });

      const body = res.json<ProjectBody>();
      expect(ids(body.environments)).toEqual([projectId, staging, preview]);
      expect(body.environments[0]).toMatchObject({ name: 'Development', isDefault: true });
      expect(body.environments[1].isDefault).toBe(false);
      for (const environment of body.environments) {
        expect(Object.values(ProjectStatus)).toContain(environment.status);
      }
    });

    it('reports a disabled Project and its environments as disabled', async () => {
      const disabledId = await createProject(app, tenant, { title: 'Retired' });
      await disableProject(disabledId);

      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${disabledId}`, headers: member.headers });

      expect(res.json()).toMatchObject({
        disabled: true,
        environments: [expect.objectContaining({ status: ProjectStatus.Disabled })],
      });
    });

    it('includes disabled Projects in the list', async () => {
      const disabledId = await createProject(app, tenant, { title: 'Also retired' });
      await disableProject(disabledId);

      const items = await listProjects(member);

      expect(ids(items)).toContain(disabledId);
    });
  });

  describe('what the caller may see', () => {
    let tenant: TenantFixture;
    let owner: MemberFixture;
    let outsider: MemberFixture;
    let publicProjectId: string;
    let sharedProjectId: string;
    let personalProjectId: string;

    beforeAll(async () => {
      tenant = await createTenant(app);
      owner = await addMember(app, tenant);
      outsider = await addMember(app, tenant);
      publicProjectId = await createProject(app, tenant, { title: 'Everyone' });
      const workspaceId = await createSharedWorkspace(app, tenant, owner);
      sharedProjectId = await createProject(app, tenant, { title: 'Team', workspaceId });
      const privateWorkspaceId = await privateWorkspaceIdOf(app, tenant, owner);
      personalProjectId = await createProject(app, tenant, { title: 'Mine', workspaceId: privateWorkspaceId });
    });

    it('shows Public Projects to every member', async () => {
      expect(ids(await listProjects(outsider))).toEqual([publicProjectId]);
    });

    it('shows workspace and personal Projects to their own members', async () => {
      expect(ids(await listProjects(owner)).toSorted()).toEqual(
        [publicProjectId, sharedProjectId, personalProjectId].toSorted()
      );
    });

    it('answers 404 for a Project in a workspace the caller is not in', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${sharedProjectId}`,
        headers: outsider.headers,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:project-not-found' });
    });

    it('answers 404 for an unknown Project id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${randomUUID()}`,
        headers: owner.headers,
      });

      expect(res.statusCode).toBe(404);
    });

    it('answers 404 for a Project in another Organization', async () => {
      const other = await createTenant(app);
      const foreignProjectId = await createProject(app, other, { title: 'Foreign' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${foreignProjectId}`,
        headers: owner.headers,
      });

      expect(res.statusCode).toBe(404);
      expect(ids(await listProjects(owner))).not.toContain(foreignProjectId);
    });

    it('hides personal Projects once the Organization turns private workspaces off', async () => {
      const closing = await createTenant(app);
      const member = await addMember(app, closing);
      const privateWorkspaceId = await privateWorkspaceIdOf(app, closing, member);
      const hiddenId = await createProject(app, closing, { title: 'Hidden', workspaceId: privateWorkspaceId });
      expect(ids(await listProjects(member))).toContain(hiddenId);

      await disablePrivateWorkspaces(closing);

      expect(ids(await listProjects(member))).not.toContain(hiddenId);
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${hiddenId}`, headers: member.headers });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('filters', () => {
    let tenant: TenantFixture;
    let member: MemberFixture;
    let workspaceId: string;
    let inWorkspaceId: string;
    let publicProjectId: string;
    let otherAgentProjectId: string;
    let otherAgentId: string;

    beforeAll(async () => {
      tenant = await createTenant(app);
      member = await addMember(app, tenant);
      workspaceId = await createSharedWorkspace(app, tenant, member);
      inWorkspaceId = await createProject(app, tenant, { title: 'Scoped', workspaceId });
      publicProjectId = await createProject(app, tenant, { title: 'Unscoped' });
      otherAgentId = (await seedLiveAgent(tenant.tenantId, member.userId)).id;
      otherAgentProjectId = await createProject(app, tenant, { title: 'Agented', agentId: otherAgentId });
    });

    it('scopes the list to one workspace', async () => {
      expect(ids(await listProjects(member, `?workspaceId=${workspaceId}`))).toEqual([inWorkspaceId]);
    });

    it('scopes the list to one Agent', async () => {
      const items = await listProjects(member, `?agentId=${otherAgentId}`);

      expect(ids(items)).toEqual([otherAgentProjectId]);
      expect(ids(await listProjects(member))).toContain(publicProjectId);
    });

    it('answers an empty page for a workspace the caller cannot see', async () => {
      const outsider = await addMember(app, tenant);

      expect(await listProjects(outsider, `?workspaceId=${workspaceId}`)).toEqual([]);
    });
  });
});
