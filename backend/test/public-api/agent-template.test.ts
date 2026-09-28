import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perms } from '../../src/permission/permission.constants';
import { defaultEnvironmentId, seedBuilderChat, seedLiveAgent, seedWorkspaceProject } from '../support/agent-fixtures';
import {
  addMember,
  createOrganization,
  platformApiKeyFor,
  type MemberFixture,
  type OrganizationFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';

const reads = vi.hoisted(() => ({ afterRead: null as null | ((path: string) => Promise<void>) }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    if (reads.afterRead) await reads.afterRead(String(args[0]));
    return content;
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface ProfileBody {
  environmentId: string;
  template: { hash: string; damaged: boolean } | null;
}

describe('PUT /agents/:id/template', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let organization: OrganizationFixture;
  let creator: MemberFixture;
  let agentId: string;
  let chatId: string;
  let chatKey: string;
  let templateDir: string;

  async function write(path: string, content = `${path}\n`): Promise<void> {
    await mkdir(dirname(join(templateDir, path)), { recursive: true });
    await writeFile(join(templateDir, path), content);
  }

  function save(headers: Record<string, string> = bearer(chatKey)) {
    return app.inject({ method: 'PUT', url: `/api/v1/agents/${agentId}/template`, headers });
  }

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
    organization = await createOrganization(app);
    creator = await addMember(app, organization, [Perms.usePublicApi, Perms.manageAgents]);

    agentId = (await seedLiveAgent(organization.tenantId, creator.userId)).id;
    const chat = await seedBuilderChat(organization.tenantId, agentId, creator.userId);
    chatId = chat.chatId;
    templateDir = chat.templateDir;
    chatKey = await platformApiKeyFor(app, organization, chatId);
  });

  beforeEach(async () => {
    await rm(templateDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('saves template/ and shows its hash on the Development entry of GET /agents/:id', async () => {
    await write('README.md');
    await write('AGENTS.md');

    const res = await save();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ hash: string; files: unknown[]; skipped: unknown[]; warnings: unknown[] }>();
    expect(body).toMatchObject({
      files: [{ path: 'README.md', size: 10, executable: false }],
      skipped: [{ path: 'AGENTS.md' }],
      warnings: [],
    });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/agents/${agentId}`, headers: bearer(chatKey) });
    const developmentId = await defaultEnvironmentId(organization.tenantId);
    const profiles = detail.json<{ profiles: ProfileBody[] }>().profiles;
    expect(profiles.find((profile) => profile.environmentId === developmentId)?.template).toEqual({
      hash: body.hash,
      damaged: false,
    });
    for (const profile of profiles.filter((entry) => entry.environmentId !== developmentId)) {
      expect(profile.template).toBeNull();
    }
  });

  it('answers 422 template-refused with one item per refused path', async () => {
    await write('README.md');
    await write('.env', 'TOKEN=1\n');
    await write('app/app.meta.json', '{}');

    const res = await save();

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:template-refused',
      errors: [
        { file: '.env', detail: expect.stringContaining('Environment settings') },
        { file: 'app/app.meta.json', detail: expect.any(String) },
      ],
    });
  });

  it('answers 409 template-changed when template/ changes during the copy', async () => {
    await write('README.md');
    reads.afterRead = async (path) => {
      if (!path.startsWith(templateDir)) return;
      reads.afterRead = null;
      await writeFile(join(templateDir, 'late.md'), 'late\n');
    };

    const res = await save();
    reads.afterRead = null;

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:template-changed' });
  });

  it('refuses a person, another chat and a Test Project', async () => {
    await write('README.md');
    const otherAgentId = (await seedLiveAgent(organization.tenantId, creator.userId)).id;
    const otherChat = await seedBuilderChat(organization.tenantId, otherAgentId, creator.userId);
    const testProjectId = await seedWorkspaceProject(organization.tenantId, {
      agentId,
      createdBy: creator.userId,
      kind: 'test',
      createdByProjectId: chatId,
    });

    const callers = [
      creator.headers,
      bearer(await platformApiKeyFor(app, organization, otherChat.chatId)),
      bearer(await platformApiKeyFor(app, organization, testProjectId)),
    ];
    for (const headers of callers) {
      const res = await save(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:forbidden' });
    }
  });
});
