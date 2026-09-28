import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projects } from '../../db/schema';
import { BuilderChatRepository } from '../../src/builder/builder-chat.repository';
import { GatewayAuthGuard } from '../../src/gateway/gateway-auth.guard';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ProjectService } from '../../src/project/project.service';
import { PROJECT_KINDS, type ProjectKind } from '../../src/project/project.types';
import { WorkspaceService } from '../../src/workspace/workspace.service';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import {
  addMember,
  createTenant,
  createProject,
  createSharedWorkspace,
  setChatSubjectVisibility,
  stampProjectKind,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';

interface ProjectBody {
  id: string;
}

function compareIds(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

function idsOf(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

function bearerContext(token: string): ExecutionContext {
  const request = { headers: { authorization: `Bearer ${token}` } };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('kind-stamped Projects are invisible everywhere a member can look', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let projectService: ProjectService;
  let tenant: TenantFixture;
  let creator: MemberFixture;
  let otherMember: MemberFixture;
  let workspaceId: string;
  let ordinaryId: string;
  const hiddenIds = new Map<ProjectKind, string>();

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
    projectService = app.get(ProjectService);

    tenant = await createTenant(app);
    creator = await addMember(app, tenant);
    otherMember = await addMember(app, tenant);
    workspaceId = await createSharedWorkspace(app, tenant, creator);
    await app.get(WorkspaceService).addMember(workspaceId, otherMember.userId, tenant.tenantId);

    ordinaryId = await createProject(app, tenant, { workspaceId, createdBy: creator.userId });
    for (const kind of PROJECT_KINDS) {
      const id = await createProject(app, tenant, { workspaceId, createdBy: creator.userId });
      await stampProjectKind(id, kind);
      hiddenIds.set(kind, id);
    }
  });

  afterAll(async () => {
    await harness.close();
  });

  it('leaves them out of findAllForUser', async () => {
    const rows = await projectService.findAllForUser({
      tenantId: tenant.tenantId,
      userId: otherMember.userId,
    });
    expect(idsOf(rows)).toEqual([ordinaryId]);
  });

  it('leaves them out of findAll', async () => {
    const rows = await projectService.findAll(tenant.tenantId);
    expect(idsOf(rows)).toEqual([ordinaryId]);
  });

  it('leaves them out of findAllInWorkspace', async () => {
    const rows = await projectService.findAllInWorkspace(tenant.tenantId, workspaceId);
    expect(idsOf(rows)).toEqual([ordinaryId]);
  });

  it('leaves them out of GET /api/v1/projects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: otherMember.headers });
    expect(res.statusCode).toBe(200);
    expect(idsOf(res.json<{ items: ProjectBody[] }>().items)).toEqual([ordinaryId]);
  });

  it('answers project-not-found for a hidden Project by id', async () => {
    for (const id of hiddenIds.values()) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: otherMember.headers });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:project-not-found' });
    }
  });

  it('hands a hidden Project by id to the caller that created it', async () => {
    for (const [kind, id] of hiddenIds) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: creator.headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, kind, createdBy: creator.userId });
    }
  });

  it('hands the chat of a public Skill and the test Project under it to another member, and still lists neither', async () => {
    const chatId = hiddenIds.get('agent_builder_chat');
    if (chatId === undefined) throw new Error('no chat-kind Project');
    const testId = await createProject(app, tenant, {
      workspaceId,
      createdBy: creator.userId,
      createdByProjectId: chatId,
    });
    await stampProjectKind(testId, 'test');

    const read = (id: string) =>
      app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: otherMember.headers });

    expect((await read(chatId)).statusCode).toBe(404);
    expect((await read(testId)).statusCode).toBe(404);

    await setChatSubjectVisibility(chatId, 'public');

    expect((await read(chatId)).statusCode).toBe(200);
    expect((await read(testId)).statusCode).toBe(200);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: otherMember.headers });
    expect(idsOf(listed.json<{ items: ProjectBody[] }>().items)).toEqual([ordinaryId]);

    await setChatSubjectVisibility(chatId, 'private');
  });

  /** The chat page reads both of these, so a shared chat that 404s here renders without a title. */
  it('hands the internal by-id reads of a shared chat to another member', async () => {
    const chatId = hiddenIds.get('skill_builder_chat');
    if (chatId === undefined) throw new Error('no chat-kind Project');
    const forOther = { projectId: chatId, tenantId: tenant.tenantId, userId: otherMember.userId };

    await expect(projectService.findOneForUser(forOther)).rejects.toBeInstanceOf(NotFoundException);
    await expect(projectService.getState(forOther)).rejects.toBeInstanceOf(NotFoundException);

    await setChatSubjectVisibility(chatId, 'public');

    expect(await projectService.findOneForUser(forOther)).toMatchObject({ id: chatId });
    expect(await projectService.getState(forOther)).toMatchObject({ id: chatId });

    await setChatSubjectVisibility(chatId, 'private');
  });

  it('leaves them out of the workspace and folder counts', async () => {
    const workspaces = await app
      .get(WorkspaceService)
      .findAll({ userId: otherMember.userId, tenantId: tenant.tenantId });
    const workspace = workspaces.find((row) => row.id === workspaceId);

    expect(workspace?.projectCount).toBe(1);
  });

  it('refuses a hidden Project to an administrator assigning it elsewhere', async () => {
    const hidden = hiddenIds.get('test');
    if (hidden === undefined) throw new Error('no test-kind Project');

    await expect(
      app.get(WorkspaceService).assignProject({
        workspaceId: null,
        projectId: hidden,
        tenantId: tenant.tenantId,
        userId: otherMember.userId,
        canManageWorkspaces: true,
        canMoveProjectsBetweenWorkspaces: true,
      })
    ).rejects.toThrow(`Project ${hidden} not found`);
  });

  it('refuses a hidden Project to a member who did not create it, and allows its creator', async () => {
    const hidden = hiddenIds.get('test');
    if (hidden === undefined) throw new Error('no test-kind Project');

    await expect(
      projectService.findOneForUser({
        projectId: hidden,
        tenantId: tenant.tenantId,
        userId: otherMember.userId,
      })
    ).rejects.toThrow(`Project ${hidden} not found`);

    const seen = await projectService.findOneForUser({
      projectId: hidden,
      tenantId: tenant.tenantId,
      userId: creator.userId,
    });
    expect(seen.kind).toBe('test');
    expect(seen.createdBy).toBe(creator.userId);
  });

  it('streams the status of a chat to its creator and to nobody else', async () => {
    const chatId = hiddenIds.get('skill_builder_chat');
    if (chatId === undefined) throw new Error('no chat-kind Project');

    const state = await projectService.getState({
      projectId: chatId,
      tenantId: tenant.tenantId,
      userId: creator.userId,
    });
    expect(state.id).toBe(chatId);

    await expect(
      projectService.getState({ projectId: chatId, tenantId: tenant.tenantId, userId: otherMember.userId })
    ).rejects.toThrow(`Project ${chatId} not found`);
  });

  it('reaches the chats only through the Builder repository', async () => {
    const repository = app.get(BuilderChatRepository);
    const found = await Promise.all(
      [...hiddenIds.values()].map((id) => repository.findChat(tenant.tenantId, id))
    );

    expect(found.flatMap((row) => (row ? [row.id] : [])).toSorted(compareIds)).toEqual(
      [hiddenIds.get('skill_builder_chat'), hiddenIds.get('agent_builder_chat')].toSorted(compareIds)
    );
  });

  it('reaches a test Project only as the child of the chat that made it', async () => {
    const testProjectId = hiddenIds.get('test');
    if (testProjectId === undefined) throw new Error('no test-kind Project');
    const chatId = hiddenIds.get('skill_builder_chat');
    if (chatId === undefined) throw new Error('no chat-kind Project');
    await db.update(projects).set({ createdByProjectId: chatId }).where(eq(projects.id, testProjectId));

    const rows = await app.get(BuilderChatRepository).testProjectsOf(chatId);

    expect(idsOf(rows)).toEqual([testProjectId]);
  });

  it('stamps the creating user on an ordinary Project', async () => {
    const [row] = await db
      .select({ createdBy: projects.createdBy, kind: projects.kind })
      .from(projects)
      .where(eq(projects.id, ordinaryId));
    expect(row).toEqual({ createdBy: creator.userId, kind: null });
  });
});

describe('gateway keys know their purpose', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let keys: GatewayKeyService;
  let tenant: TenantFixture;
  let projectId: string;

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
    keys = app.get(GatewayKeyService);
    tenant = await createTenant(app);
    projectId = await createProject(app, tenant);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('mints one key per purpose and resolves each only under its own purpose', async () => {
    const service = await keys.getEnvironmentToken(projectId);
    if (service === null) throw new Error('the Project has no service key');

    const platform = await keys.createKey(projectId, projectId, tenant.tenantId, 'platform-api');
    expect(platform).not.toBe(service);

    expect(await keys.validateToken(service, 'service')).toMatchObject({ projectId });
    expect(await keys.validateToken(platform, 'platform-api')).toMatchObject({ projectId });
    expect(await keys.validateToken(platform, 'service')).toBeNull();
    expect(await keys.validateToken(service, 'platform-api')).toBeNull();
  });

  it('refuses a platform-api key at the gateway guard', async () => {
    const platform = await keys.createKey(projectId, projectId, tenant.tenantId, 'platform-api');
    const service = await keys.getEnvironmentToken(projectId);
    if (service === null) throw new Error('the Project has no service key');
    const guard = new GatewayAuthGuard(keys);

    await expect(guard.canActivate(bearerContext(platform))).rejects.toThrow('Invalid gateway token');
    expect(await guard.canActivate(bearerContext(service))).toBe(true);
  });
});

describe('no query over projects forgets the kind filter', () => {
  const SANCTIONED = [
    /visible\.where/,
    /accessible\.where/,
    /isNull\(projects\.kind\)/,
    /eq\(projects\.kind/,
    /inArray\(projects\.kind/,
    /eq\(projects\.id/,
  ];
  const QUERIES_PROJECTS = /\.from\(projects\)|this\.baseQuery\(\)/;
  const JOINS_ONLY = new Set(['baseQuery']);
  const MEMBER = /\n {2}(?:private |public )?(?:async )?([A-Za-z]\w*)\s*\(/g;

  const FILES = [
    'src/builder/builder-chat.repository.ts',
    'src/project/project.service.ts',
    'src/public-api/projects/projects.repository.ts',
    'src/workspace/workspace.service.ts',
  ];

  function membersOf(source: string): { name: string; body: string }[] {
    const starts = [...source.matchAll(MEMBER)].map((match) => ({ name: match[1], at: match.index }));
    return starts.map((member, index) => ({
      name: member.name,
      body: source.slice(member.at, starts[index + 1]?.at ?? source.length),
    }));
  }

  for (const file of FILES) {
    it(`${file} scopes or pins every select over projects`, () => {
      const source = readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      const querying = membersOf(source).filter(
        (member) => QUERIES_PROJECTS.test(member.body) && !JOINS_ONLY.has(member.name)
      );

      expect(querying.length).toBeGreaterThan(0);
      const unscoped = querying
        .filter((member) => !SANCTIONED.some((marker) => marker.test(member.body)))
        .map((member) => member.name);
      expect(unscoped).toEqual([]);
    });
  }
});
