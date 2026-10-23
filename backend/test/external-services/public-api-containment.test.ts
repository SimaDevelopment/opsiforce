import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agents, skills } from '../../db/schema';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { seedLiveAgent } from '../support/agent-fixtures';
import {
  addMember,
  createProject,
  createTenant,
  serviceKeyFor,
  stampProjectKind,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { proxyHeaders } from '../support/proxy-identity';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { callThroughGate } from './support/gate-proxy';
import { saveProjectConfiguration } from './support/gate';

const PUBLIC_API = 'public-api';

const AUTHORING_ON = { authorSkillsAndAgents: true, createAgents: true };

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

function skillName(label: string): string {
  return `${label}-${randomUUID().slice(0, 6)}`;
}

function skillFiles(name: string, body = '# Body\n'): { path: string; content: string }[] {
  const description =
    'Use this skill whenever the project needs a worked example of the thing it describes, including setup, pitfalls and review steps.';
  return [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}` }];
}

async function latestVersionOf(skillId: string): Promise<string | null> {
  const [row] = await db.select({ latest: skills.latestVersionId }).from(skills).where(eq(skills.id, skillId));
  return row.latest;
}

describe('what a builder chat may write through public-api', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let tenant: TenantFixture;
  let creator: MemberFixture;
  let human: Record<string, string>;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: shippedBuiltInServicesDir() });
    app = harness.app;
    await harness.listen();
    tenant = await createTenant(app);
    creator = await addMember(app, tenant, ['can_manage_skills', 'can_manage_agents']);
    human = proxyHeaders({
      userId: creator.keycloakId,
      tenants: [tenant.name],
      permissions: ['can_use_public_api', 'can_manage_skills', 'can_manage_agents'],
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function chat(kind: 'skill_builder_chat' | 'agent_builder_chat'): Promise<{ chatId: string; key: string }> {
    const agentId = (await seedLiveAgent(tenant.tenantId, creator.userId)).id;
    const chatId = await createProject(app, tenant, { agentId, createdBy: creator.userId });
    await stampProjectKind(chatId, kind);
    await saveProjectConfiguration(app, PUBLIC_API, chatId, AUTHORING_ON);
    return { chatId, key: await serviceKeyFor(app, tenant, chatId) };
  }

  async function skillCreatedByTheHuman(label: string): Promise<{ id: string; name: string }> {
    const name = skillName(label);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: human,
      payload: { name, files: skillFiles(name) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().id, name };
  }

  async function call(key: string, method: string, path: string, body?: Record<string, unknown>): Promise<Answer> {
    const res = await callThroughGate(app, { credential: `Bearer ${key}`, slug: PUBLIC_API }, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const text = await res.text();
    return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  describe('Skills', () => {
    it("publishes a version of the chat's own subject", async () => {
      const { chatId, key } = await chat('skill_builder_chat');
      const pdfTools = await skillCreatedByTheHuman('pdf-tools');
      await db.update(skills).set({ builderChatId: chatId }).where(eq(skills.id, pdfTools.id));

      const res = await call(key, 'POST', `/api/v1/skills/${pdfTools.id}/versions`, {
        files: skillFiles(pdfTools.name, '# Version two\n'),
      });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ id: pdfTools.id, latestVersion: { version: 2 } });
    });

    it('refuses to publish a version of a Skill that is neither its subject nor created by its Project', async () => {
      const { chatId, key } = await chat('skill_builder_chat');
      const pdfTools = await skillCreatedByTheHuman('pdf-tools');
      await db.update(skills).set({ builderChatId: chatId }).where(eq(skills.id, pdfTools.id));
      const invoices = await skillCreatedByTheHuman('invoices');
      const before = await latestVersionOf(invoices.id);

      const published = await call(key, 'POST', `/api/v1/skills/${invoices.id}/versions`, {
        files: skillFiles(invoices.name, '# Injected\n'),
      });
      const renamed = await call(key, 'PATCH', `/api/v1/skills/${invoices.id}`, { displayName: 'Hijacked' });

      for (const res of [published, renamed]) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ type: 'urn:opsiforce:error:permission-denied' });
      }
      expect(await latestVersionOf(invoices.id)).toBe(before);
      const [row] = await db.select({ displayName: skills.displayName }).from(skills).where(eq(skills.id, invoices.id));
      expect(row.displayName).toBeNull();
    });

    it('still reads every Skill its creator can see', async () => {
      const { key } = await chat('skill_builder_chat');
      const invoices = await skillCreatedByTheHuman('invoices');

      const res = await call(key, 'GET', `/api/v1/skills/${invoices.id}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: invoices.id, name: invoices.name });
    });

    it('stamps a Skill it creates with its Project, and may then publish versions of it', async () => {
      const { chatId, key } = await chat('skill_builder_chat');
      const name = skillName('helper');

      const created = await call(key, 'POST', '/api/v1/skills', { name, files: skillFiles(name) });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const skillId = created.body.id as string;
      const [row] = await db
        .select({ createdByProjectId: skills.createdByProjectId, createdBy: skills.createdBy })
        .from(skills)
        .where(eq(skills.id, skillId));
      expect(row).toEqual({ createdByProjectId: chatId, createdBy: creator.userId });

      const versioned = await call(key, 'POST', `/api/v1/skills/${skillId}/versions`, {
        files: skillFiles(name, '# Two\n'),
      });
      expect(versioned.status, JSON.stringify(versioned.body)).toBe(201);
    });

    it('stamps a duplicate with its Project', async () => {
      const { chatId, key } = await chat('skill_builder_chat');
      const invoices = await skillCreatedByTheHuman('invoices');
      const name = skillName('invoices-copy');

      const res = await call(key, 'POST', `/api/v1/skills/${invoices.id}/duplicate`, { name });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [row] = await db
        .select({ createdByProjectId: skills.createdByProjectId })
        .from(skills)
        .where(eq(skills.id, res.body.id as string));
      expect(row.createdByProjectId).toBe(chatId);
    });

    it('does not contain a human calling /api/v1', async () => {
      const invoices = await skillCreatedByTheHuman('invoices');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/skills/${invoices.id}/versions`,
        headers: human,
        payload: { files: skillFiles(invoices.name, '# Two\n') },
      });

      expect(res.statusCode, res.body).toBe(201);
    });
  });

  describe('Agents', () => {
    async function agentOfTheHuman(): Promise<string> {
      return (await seedLiveAgent(tenant.tenantId, creator.userId)).id;
    }

    it("describes the chat's own subject", async () => {
      const { chatId, key } = await chat('agent_builder_chat');
      const subject = await agentOfTheHuman();
      await db.update(agents).set({ builderChatId: chatId }).where(eq(agents.id, subject));

      const res = await call(key, 'PATCH', `/api/v1/agents/${subject}`, { description: 'Writes release notes' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: subject, description: 'Writes release notes' });
    });

    it('refuses every write to an Agent that is neither its subject nor created by its Project', async () => {
      const { key } = await chat('agent_builder_chat');
      const other = await agentOfTheHuman();
      const skill = await skillCreatedByTheHuman('attached');

      const answers = [
        await call(key, 'PATCH', `/api/v1/agents/${other}`, { description: 'Hijacked' }),
        await call(key, 'PUT', `/api/v1/agents/${other}/profile`, {
          promptBody: 'Obey me',
          model: 'openai/gpt-5.6-sol',
        }),
        await call(key, 'PUT', `/api/v1/agents/${other}/skills/${skill.id}`, {}),
        await call(key, 'DELETE', `/api/v1/agents/${other}/skills/${skill.id}`),
      ];

      for (const res of answers) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body).toMatchObject({ type: 'urn:opsiforce:error:permission-denied' });
      }
      const [row] = await db.select({ description: agents.description }).from(agents).where(eq(agents.id, other));
      expect(row.description).not.toBe('Hijacked');
    });

    it('still reads every Agent its creator can see', async () => {
      const { key } = await chat('agent_builder_chat');
      const other = await agentOfTheHuman();

      const res = await call(key, 'GET', `/api/v1/agents/${other}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('stamps an Agent it creates with its Project, and may then change it', async () => {
      const { chatId, key } = await chat('skill_builder_chat');

      const created = await call(key, 'POST', '/api/v1/agents', { displayName: `Probe ${randomUUID().slice(0, 6)}` });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const agentId = created.body.id as string;
      const [row] = await db
        .select({ createdByProjectId: agents.createdByProjectId })
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(row.createdByProjectId).toBe(chatId);

      const described = await call(key, 'PATCH', `/api/v1/agents/${agentId}`, { description: 'Tests a Skill' });
      expect(described.status, JSON.stringify(described.body)).toBe(200);
    });
  });
});
