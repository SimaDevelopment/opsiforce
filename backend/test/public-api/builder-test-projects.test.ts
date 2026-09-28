import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentSettings, agents, environments, projectEnvironments, projects, skills } from '../../db/schema';
import { BUILDER_AGENT_SLUG } from '../../src/agent/agent-visibility';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { Perms } from '../../src/permission/permission.constants';
import { PodService } from '../../src/pod/pod.service';
import { ProjectService } from '../../src/project/project.service';
import type { FakeBifrostService, FakePodService } from '../support/infra-fakes';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import {
  addMember,
  createTenant,
  createProject,
  platformApiKeyFor,
  stampProjectKind,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const IMAGE_MIGRATE_SCRIPT = resolve('../agent-config/scripts/agent-workspace-migrate.mjs');

async function imageWithPlatformIgnores(gitignore: string): Promise<string> {
  const { withPlatformIgnores } = (await import(IMAGE_MIGRATE_SCRIPT)) as { withPlatformIgnores(text: string): string };
  return withPlatformIgnores(gitignore);
}

function workspaceOf(projectId: string): string {
  return join(storageMountPath, 'projects', projectId);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@opsiforce.local', '-c', 'user.name=Test', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: dir, encoding: 'utf8' }
  ).trim();
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

describe('a Builder chat pod creating a test Project', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let tenant: TenantFixture;
  let creator: MemberFixture;
  let colleague: MemberFixture;
  let childAgentId: string;
  let chatId: string;
  let chatKey: string;
  let otherAgentId: string;
  let chatAgentId: string;

  async function defaultToProduction(agentId: string): Promise<void> {
    const [production] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(
        and(
          eq(environments.tenantId, tenant.tenantId),
          eq(environments.isDefault, false),
          eq(environments.isProtected, true)
        )
      );
    await db
      .update(agentSettings)
      .set({ defaultEnvironmentId: production.id })
      .where(eq(agentSettings.agentId, agentId));
  }

  async function skillChatKey(): Promise<string> {
    const skillChatId = await createProject(app, tenant, { agentId: chatAgentId, createdBy: creator.userId });
    await stampProjectKind(skillChatId, 'skill_builder_chat');
    const skillId = randomUUID();
    await db.insert(skills).values({
      id: skillId,
      tenantId: tenant.tenantId,
      origin: 'custom',
      name: `subject-${skillId.slice(0, 8)}`,
      visibility: 'private',
      createdBy: creator.userId,
      builderChatId: skillChatId,
    });
    return platformApiKeyFor(app, tenant, skillChatId);
  }

  async function createTestProject(title: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: bearer(chatKey),
      payload: { title, agentId: childAgentId, kind: 'test' },
    });
  }

  async function testProjectIdsOfChat(): Promise<string[]> {
    const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.createdByProjectId, chatId));
    return rows.map((row) => row.id);
  }

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;

    tenant = await createTenant(app);
    creator = await addMember(app, tenant, [Perms.usePublicApi, Perms.deleteProject, Perms.manageAgents]);
    colleague = await addMember(app, tenant, [Perms.usePublicApi]);

    const chatAgent = await seedLiveAgent(tenant.tenantId, creator.userId);
    await db.update(agentSettings).set({ platformApi: true }).where(eq(agentSettings.agentId, chatAgent.id));
    childAgentId = (await seedLiveAgent(tenant.tenantId, creator.userId, { visibility: 'private' })).id;
    otherAgentId = (await seedLiveAgent(tenant.tenantId, creator.userId)).id;
    chatAgentId = chatAgent.id;

    chatId = await createProject(app, tenant, { agentId: chatAgent.id, createdBy: creator.userId });
    await stampProjectKind(chatId, 'agent_builder_chat');
    await db.update(agents).set({ builderChatId: chatId }).where(eq(agents.id, childAgentId));
    await defaultToProduction(childAgentId);
    chatKey = await platformApiKeyFor(app, tenant, chatId);
  });

  afterEach(async () => {
    for (const id of await testProjectIdsOfChat()) await app.get(ProjectService).remove(id, tenant.tenantId);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('stamps the test kind, and answers a second create with 409 and the first one’s id, deleting nothing', async () => {
    const first = await createTestProject('First run');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ kind: 'test', createdByProjectId: chatId, createdBy: creator.userId });
    const firstId = first.json<{ id: string }>().id;

    const second = await createTestProject('Second run');

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      type: 'urn:opsiforce:error:test-project-exists',
      status: 409,
      testProjectId: firstId,
    });
    expect(await testProjectIdsOfChat()).toEqual([firstId]);
  });

  it('names the chat’s Test Project on GET /me, and nothing for anyone else', async () => {
    const me = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect((await me(bearer(chatKey))).json()).toMatchObject({ builderTestProject: null });

    const id = (await createTestProject('Found again')).json<{ id: string }>().id;

    expect((await me(bearer(chatKey))).json()).toMatchObject({ builderTestProject: { id } });
    expect((await me(creator.headers)).json()).toMatchObject({ builderTestProject: null });
    const testKey = await platformApiKeyFor(app, tenant, id);
    expect((await me(bearer(testKey))).json()).toMatchObject({ builderTestProject: null });
  });

  it('hands the test Project to its creator and to the pod, and hides it from a colleague', async () => {
    const created = await createTestProject('Readable run');
    const id = created.json<{ id: string }>().id;

    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: bearer(chatKey) })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: creator.headers })).statusCode
    ).toBe(200);

    const refused = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: colleague.headers });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ type: 'urn:opsiforce:error:project-not-found' });
  });

  it('keeps test Projects out of every list', async () => {
    await createTestProject('Unlisted run');

    const seen = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: creator.headers });

    expect(seen.json<{ items: { kind: string | null }[] }>().items.every((row) => row.kind === null)).toBe(true);
  });

  it('tests an Agent that has no Profile at its Default environment yet', async () => {
    const created = await createTestProject('Before first publish');

    expect(created.statusCode).toBe(201);
    const ordinary = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: creator.headers,
      payload: { title: 'Not published yet', agentId: childAgentId },
    });
    expect(ordinary.statusCode).toBe(422);
  });

  it("refuses an Agent chat's test Project on any Agent but its subject", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: bearer(chatKey),
      payload: { title: 'Wrong Agent', agentId: otherAgentId, kind: 'test' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:invalid-reference',
      errors: [expect.objectContaining({ pointer: '#/agentId' })],
    });
  });

  it("lets a Skill chat's test Project run on any Agent", async () => {
    const key = await skillChatKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: bearer(key),
      payload: { title: 'Skill on another Agent', agentId: otherAgentId, kind: 'test' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'test' });
  });

  it('refuses kind from a person', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: creator.headers,
      payload: { title: 'Not a test', agentId: childAgentId, kind: 'test' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:invalid-reference' });
  });

  it('refuses kind from a pod whose own Project is not a Builder chat', async () => {
    const ordinaryId = await createProject(app, tenant, { createdBy: creator.userId });
    const ordinaryKey = await platformApiKeyFor(app, tenant, ordinaryId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: bearer(ordinaryKey),
      payload: { title: 'Not a test', agentId: childAgentId, kind: 'test' },
    });

    expect(res.statusCode).toBe(422);
  });

  it('refuses a person naming the Skill & Agent Builder', async () => {
    const builderAgentId = await ensureBuiltInAgent(BUILDER_AGENT_SLUG);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: creator.headers,
      payload: { title: 'Sneaking in', agentId: builderAgentId },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:invalid-reference' });
  });
  describe('refreshing the Test Project', () => {
    let testId: string;

    async function saveTemplate(files: Record<string, string>): Promise<void> {
      const templateDir = join(workspaceOf(chatId), 'template');
      await rm(templateDir, { recursive: true, force: true });
      await writeTree(templateDir, files);
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${childAgentId}/template`,
        headers: bearer(chatKey),
      });
      expect(saved.statusCode).toBe(200);
    }

    function refresh(action: 'update' | 'reset', headers: Record<string, string> = bearer(chatKey), id = testId) {
      return app.inject({ method: 'POST', url: `/api/v1/projects/${id}/test/${action}`, headers });
    }

    function pods(): FakePodService {
      return app.get(PodService) as unknown as FakePodService;
    }

    function bifrost(): FakeBifrostService {
      return app.get(BifrostService) as unknown as FakeBifrostService;
    }

    beforeEach(async () => {
      await saveTemplate({ 'README.md': '# First\n', 'app/dropped.md': 'dropped\n' });
      testId = (await createTestProject('Refreshed run')).json<{ id: string }>().id;
      const workspace = workspaceOf(testId);
      git(workspace, 'init', '-q');
      git(workspace, 'add', '-A');
      git(workspace, 'commit', '-q', '-m', 'Initial template');
    });

    it('overlays the saved Development Template without deleting, commits it as "Template update", and leaves the pod and the spend alone', async () => {
      const workspace = workspaceOf(testId);
      await writeFile(join(workspace, 'child.md'), 'the child wrote this\n');
      await saveTemplate({ 'README.md': '# Second\n', 'app/added.md': 'added\n' });
      const podCallsBefore = pods().calls.length;
      const spendResetsBefore = bifrost().callsTo('resetProjectSpend').length;

      const res = await refresh('update');

      expect(res.statusCode).toBe(204);
      expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe('# Second\n');
      expect(await readFile(join(workspace, 'app/added.md'), 'utf8')).toBe('added\n');
      expect(await readFile(join(workspace, 'app/dropped.md'), 'utf8')).toBe('dropped\n');
      expect(git(workspace, 'log', '-1', '--format=%s')).toBe('Template update');
      expect(git(workspace, 'show', '--name-only', '--format=', 'HEAD').split('\n').toSorted()).toEqual([
        'README.md',
        'app/added.md',
      ]);
      expect(git(workspace, 'status', '--porcelain')).toBe('?? child.md');
      expect(
        pods()
          .calls.slice(podCallsBefore)
          .map((call) => call.method)
      ).not.toContain('deletePod');
      expect(
        pods()
          .calls.slice(podCallsBefore)
          .map((call) => call.method)
      ).not.toContain('deletePodAndWait');
      expect(bifrost().callsTo('resetProjectSpend')).toHaveLength(spendResetsBefore);
    });

    it("keeps the platform ignores when an update overlays the Template's own root .gitignore", async () => {
      const workspace = workspaceOf(testId);
      await saveTemplate({ 'README.md': '# Second\n', '.gitignore': 'dist/\n' });

      expect((await refresh('update')).statusCode).toBe(204);

      const gitignore = await readFile(join(workspace, '.gitignore'), 'utf8');
      expect(gitignore).toBe(await imageWithPlatformIgnores('dist/\n'));
      expect(gitignore).toContain('.opencode/');
      expect(git(workspace, 'show', 'HEAD:.gitignore')).toBe(gitignore.trim());
    });

    it('lays the same Project again from scratch, unpins its session, resets its spend and starts the pod', async () => {
      const workspace = workspaceOf(testId);
      await writeFile(join(workspace, 'child.md'), 'the child wrote this\n');
      await db.update(projectEnvironments).set({ sessionId: 'ses_before' }).where(eq(projectEnvironments.id, testId));
      await saveTemplate({ 'README.md': '# Second\n' });

      const res = await refresh('reset');

      expect(res.statusCode).toBe(204);
      expect(existsSync(join(workspace, 'child.md'))).toBe(false);
      expect(existsSync(join(workspace, '.git'))).toBe(false);
      expect(existsSync(join(workspace, 'app/dropped.md'))).toBe(false);
      expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe('# Second\n');
      expect(existsSync(join(workspace, '.opencode', 'opencode.json'))).toBe(true);

      const [environment] = await db
        .select({ sessionId: projectEnvironments.sessionId, status: projectEnvironments.status })
        .from(projectEnvironments)
        .where(eq(projectEnvironments.id, testId));
      expect(environment).toEqual({ sessionId: null, status: 'starting' });
      expect(bifrost().callsTo('resetProjectSpend')).toContainEqual({
        method: 'resetProjectSpend',
        args: { projectId: testId },
      });
      expect(pods().callsTo('deletePodAndWait')).toContainEqual({
        method: 'deletePodAndWait',
        args: { podName: pods().assignedPodName(testId) },
      });
      expect(await testProjectIdsOfChat()).toEqual([testId]);
      const same = await app.inject({ method: 'GET', url: `/api/v1/projects/${testId}`, headers: bearer(chatKey) });
      expect(same.json()).toMatchObject({ id: testId, kind: 'test' });
    });

    it('refuses both refreshes to everyone but the chat that created the Test Project', async () => {
      const testKey = await platformApiKeyFor(app, tenant, testId);
      const otherChatKey = await skillChatKey();
      const ordinary = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: bearer(chatKey),
        payload: { title: 'Not a test', agentId: otherAgentId },
      });
      expect(ordinary.statusCode).toBe(201);
      const ordinaryId = ordinary.json<{ id: string }>().id;

      for (const action of ['update', 'reset'] as const) {
        expect((await refresh(action, creator.headers)).json()).toMatchObject({
          status: 403,
          type: 'urn:opsiforce:error:permission-denied',
        });
        expect((await refresh(action, colleague.headers)).statusCode).toBe(404);
        expect((await refresh(action, bearer(testKey))).statusCode).toBe(404);
        expect((await refresh(action, bearer(otherChatKey))).statusCode).toBe(404);
        expect((await refresh(action, bearer(chatKey), ordinaryId)).statusCode).toBe(403);
      }
      expect(await readFile(join(workspaceOf(testId), 'app/dropped.md'), 'utf8')).toBe('dropped\n');
      expect(
        bifrost()
          .callsTo('resetProjectSpend')
          .map((call) => call.args.projectId)
      ).not.toContain(testId);
    });
  });
});
