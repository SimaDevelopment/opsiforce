import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentSettings, projects } from '../../db/schema';
import { BUILDER_AGENT_SLUG } from '../../src/agent/agent-visibility';
import { Perms } from '../../src/permission/permission.constants';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import {
  addMember,
  createOrganization,
  createProject,
  platformApiKeyFor,
  stampProjectKind,
  type MemberFixture,
  type OrganizationFixture,
} from '../support/project-fixtures';

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('a Builder chat pod creating a test Project', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let organization: OrganizationFixture;
  let creator: MemberFixture;
  let colleague: MemberFixture;
  let childAgentId: string;
  let chatId: string;
  let chatKey: string;

  async function createTestProject(title: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: bearer(chatKey),
      payload: { title, agentId: childAgentId, kind: 'test' },
    });
  }

  async function testProjectIdsOfChat(): Promise<string[]> {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.createdByProjectId, chatId));
    return rows.map((row) => row.id);
  }

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;

    organization = await createOrganization(app);
    creator = await addMember(app, organization, [Perms.usePublicApi, Perms.deleteProject]);
    colleague = await addMember(app, organization, [Perms.usePublicApi]);

    const chatAgent = await seedLiveAgent(organization.tenantId, creator.userId);
    await db.update(agentSettings).set({ platformApi: true }).where(eq(agentSettings.agentId, chatAgent.id));
    childAgentId = (await seedLiveAgent(organization.tenantId, creator.userId)).id;

    chatId = await createProject(app, organization, { agentId: chatAgent.id, createdBy: creator.userId });
    await stampProjectKind(chatId, 'agent_builder_chat');
    chatKey = await platformApiKeyFor(app, organization, chatId);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('stamps the test kind and keeps only the newest one alive', async () => {
    const first = await createTestProject('First run');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ kind: 'test', createdByProjectId: chatId, createdBy: creator.userId });

    const second = await createTestProject('Second run');
    expect(second.statusCode).toBe(201);

    expect(await testProjectIdsOfChat()).toEqual([second.json<{ id: string }>().id]);
  });

  it('hands the test Project to its creator and to the pod, and hides it from a colleague', async () => {
    const created = await createTestProject('Readable run');
    const id = created.json<{ id: string }>().id;

    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: bearer(chatKey) })).statusCode).toBe(
      200
    );
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
    const ordinaryId = await createProject(app, organization, { createdBy: creator.userId });
    const ordinaryKey = await platformApiKeyFor(app, organization, ordinaryId);

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
});
