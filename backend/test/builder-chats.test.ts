import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { eq } from 'drizzle-orm';
import {
  BadRequestException,
  ForbiddenException,
  Module,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db';
import { projects, skills } from '../db/schema';
import { BUILDER_AGENT_SLUG } from '../src/agent/agent-visibility';
import { BuilderController } from '../src/builder/builder.controller';
import type { BuilderChatCaller } from '../src/builder/builder.types';
import { configuration } from '../src/config/configuration';
import { Perms } from '../src/permission/permission.constants';
import { PermissionGuard } from '../src/permission/permission.guard';
import { isProjectAccessible } from '../src/project/project-visibility';
import type { ChatKind } from '../src/project/project.types';
import { TenantGuard } from '../src/tenant/tenant.guard';
import { ensureBuiltInAgent, seedLiveAgent } from './support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';
import { DomainTestModule } from './support/domain-module';
import { createUserRow } from './support/org-fixtures';
import {
  addMember,
  createOrganization,
  type MemberFixture,
  type OrganizationFixture,
} from './support/project-fixtures';

@Module({
  controllers: [BuilderController],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
class BuilderApiTestModule {}

let harness: DomainTestHarness;
let tenantId: string;
let creator: BuilderChatCaller;
let colleague: BuilderChatCaller;
let builderAgentId: string;
let ordinaryAgentId: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  builderAgentId = await ensureBuiltInAgent(BUILDER_AGENT_SLUG);

  const tenant = await harness.tenants.getOrCreateTenant(`builder-${randomUUID()}`);
  tenantId = tenant.id;
  await harness.environments.ensureDefaultForTenant(tenantId);

  creator = { tenantId, userId: await createUserRow() };
  colleague = { tenantId, userId: await createUserRow() };
  ordinaryAgentId = (await seedLiveAgent(tenantId, creator.userId)).id;
});

afterAll(async () => {
  await harness.close();
});

function newChat(caller: BuilderChatCaller, kind: ChatKind = 'skill_builder_chat', title?: string) {
  return harness.builderChats.create(caller, { kind, title });
}

async function seedTestProject(chatId: string): Promise<string> {
  const project = await harness.projects.create(
    { title: `test-${randomUUID().slice(0, 8)}`, agentId: ordinaryAgentId },
    tenantId,
    { createdBy: creator.userId, createdByProjectId: chatId, kind: 'test' }
  );
  return project.id;
}

async function seedSkill(name: string, chatId?: string): Promise<string> {
  const id = randomUUID();
  await db.insert(skills).values({
    id,
    tenantId,
    origin: 'custom',
    name,
    visibility: 'public',
    createdBy: creator.userId,
    ...(chatId === undefined ? {} : { createdInChatProjectId: chatId }),
  });
  return id;
}

async function isReachableBy(userId: string, projectId: string): Promise<boolean> {
  return isProjectAccessible(tenantId, userId, projectId);
}

async function kindOf(projectId: string): Promise<string | null | undefined> {
  const [row] = await db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, projectId));
  return row?.kind;
}

describe('starting a Builder chat', () => {
  it('stamps the chat kind, the Builder Agent and the creator, in no workspace', async () => {
    const chat = await newChat(creator, 'agent_builder_chat', 'Weekly digest agent');

    const [row] = await db.select().from(projects).where(eq(projects.id, chat.id));
    expect(row).toMatchObject({
      kind: 'agent_builder_chat',
      agentId: builderAgentId,
      workspaceId: null,
      createdBy: creator.userId,
      title: 'Weekly digest agent',
    });
    expect(chat.canOpen).toBe(true);
    expect(chat.seedPrompt).toBeNull();
  });

  it('names an untitled chat after its kind', async () => {
    expect((await newChat(creator, 'skill_builder_chat')).title).toBe('New Skill');
    expect((await newChat(creator, 'agent_builder_chat')).title).toBe('New Agent');
  });

  it('renders an Edit-with-Builder seed for the client to send as the first prompt', async () => {
    const name = `seeded-${randomUUID().slice(0, 8)}`;
    const skillId = await seedSkill(name);

    const chat = await harness.builderChats.create(creator, { kind: 'skill_builder_chat', seed: { skillId } });

    expect(chat.seedPrompt).toContain(name);
  });

  it('refuses a seed naming an artifact the caller cannot see', async () => {
    await expect(
      harness.builderChats.create(creator, { kind: 'skill_builder_chat', seed: { skillId: randomUUID() } })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the shared chat list', () => {
  it('shows every chat in the Organization, openable only by whoever started it', async () => {
    const mine = await newChat(creator);
    const theirs = await newChat(colleague);

    const byId = new Map((await harness.builderChats.list(creator, 'active')).map((row) => [row.id, row]));

    expect(byId.get(mine.id)?.canOpen).toBe(true);
    expect(byId.get(theirs.id)?.canOpen).toBe(false);
    expect(byId.get(theirs.id)?.createdBy?.id).toBe(colleague.userId);
  });

  it('narrows to chats the caller started under the mine filter', async () => {
    const mine = await newChat(creator);
    const theirs = await newChat(colleague);

    const seen = await harness.builderChats.list(creator, 'mine');

    expect(seen.map((row) => row.id)).toContain(mine.id);
    expect(seen.map((row) => row.id)).not.toContain(theirs.id);
    expect(seen.every((row) => row.canOpen)).toBe(true);
  });

  it('opens a chat for its creator and hides it from the colleague who can see it listed', async () => {
    const mine = await newChat(creator);

    const opened = await harness.builderChats.open(creator, mine.id);
    expect(opened).toMatchObject({ id: mine.id, canOpen: true });

    const listed = await harness.builderChats.list(colleague, 'active');
    expect(listed.map((row) => row.id)).toContain(mine.id);
    await expect(harness.builderChats.open(colleague, mine.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports the live test Project and what the chat produced', async () => {
    const chat = await newChat(creator);
    const testProjectId = await seedTestProject(chat.id);
    const name = `made-${randomUUID().slice(0, 8)}`;
    const skillId = await seedSkill(name, chat.id);

    const row = (await harness.builderChats.list(creator, 'mine')).find((seen) => seen.id === chat.id);

    expect(row?.testProject?.id).toBe(testProjectId);
    expect(row?.produced).toEqual([{ type: 'skill', id: skillId, name }]);
  });
});

describe('sharing a chat with the Organization', () => {
  it('starts a chat private and lets only its creator widen it', async () => {
    const chat = await newChat(creator);
    expect(chat.visibility).toBe('private');
    expect(chat.canShare).toBe(true);

    await expect(harness.builderChats.setVisibility(colleague, chat.id, 'public')).rejects.toBeInstanceOf(
      ForbiddenException
    );

    const shared = await harness.builderChats.setVisibility(creator, chat.id, 'public');
    expect(shared.visibility).toBe('public');
  });

  it('opens a public chat for any holder, who may not share it back', async () => {
    const chat = await newChat(creator);
    await harness.builderChats.setVisibility(creator, chat.id, 'public');

    const opened = await harness.builderChats.open(colleague, chat.id);
    expect(opened).toMatchObject({ id: chat.id, canOpen: true, canShare: false });
  });

  it('closes a public chat again, unlike a Skill or an Agent', async () => {
    const chat = await newChat(creator);
    await harness.builderChats.setVisibility(creator, chat.id, 'public');

    const closed = await harness.builderChats.setVisibility(creator, chat.id, 'private');

    expect(closed.visibility).toBe('private');
    await expect(harness.builderChats.open(colleague, chat.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a visibility that is neither private nor public', async () => {
    const chat = await newChat(creator);

    await expect(harness.builderChats.setVisibility(creator, chat.id, 'organization' as never)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('carries the chat visibility down to the test Project it is running', async () => {
    const chat = await newChat(creator);
    const testProjectId = await seedTestProject(chat.id);

    expect(await isReachableBy(colleague.userId, testProjectId)).toBe(false);

    await harness.builderChats.setVisibility(creator, chat.id, 'public');

    expect(await isReachableBy(colleague.userId, testProjectId)).toBe(true);
  });

  it("reads the governing chat, never the test Project's own visibility column", async () => {
    const chat = await newChat(creator);
    const testProjectId = await seedTestProject(chat.id);

    await db.update(projects).set({ chatVisibility: 'public' }).where(eq(projects.id, testProjectId));

    expect(await isReachableBy(colleague.userId, testProjectId)).toBe(false);
  });

  it('leaves an orphaned test Project private when its chat is gone', async () => {
    const chat = await newChat(creator);
    const testProjectId = await seedTestProject(chat.id);
    await harness.builderChats.setVisibility(creator, chat.id, 'public');

    await db
      .update(projects)
      .set({ createdByProjectId: null, chatVisibility: 'public' })
      .where(eq(projects.id, testProjectId));

    expect(await isReachableBy(colleague.userId, testProjectId)).toBe(false);
  });

  it('keeps a public chat out of the ordinary Project list', async () => {
    const chat = await newChat(creator);
    await harness.builderChats.setVisibility(creator, chat.id, 'public');

    const listed = await harness.projects.findAllForUser({ tenantId, userId: colleague.userId });

    expect(listed.map((row) => row.id)).not.toContain(chat.id);
  });
});

describe('archiving, restoring and deleting a chat', () => {
  it('keeps the row and destroys the pods on archive, and brings it back on restore', async () => {
    const chat = await newChat(creator);

    const podName = harness.fakes.pods.assignedPodName(chat.id);

    const archived = await harness.builderChats.archive(colleague, chat.id);
    expect(archived.disabled).toBe(true);
    expect(harness.fakes.pods.callsTo('deletePod').some((call) => call.args.podName === podName)).toBe(true);
    expect((await harness.builderChats.list(creator, 'active')).map((row) => row.id)).not.toContain(chat.id);
    expect((await harness.builderChats.list(creator, 'archived')).map((row) => row.id)).toContain(chat.id);

    const restored = await harness.builderChats.restore(colleague, chat.id);
    expect(restored.disabled).toBe(false);
  });

  it('keeps the test Project of an archived chat', async () => {
    const chat = await newChat(creator);
    const testProjectId = await seedTestProject(chat.id);

    await harness.builderChats.archive(creator, chat.id);

    expect(await kindOf(testProjectId)).toBe('test');
  });

  it('takes the live test Project with the chat on delete', async () => {
    const chat = await newChat(creator);
    const testProjectId = await seedTestProject(chat.id);

    await harness.builderChats.remove(colleague, chat.id);

    expect(await kindOf(chat.id)).toBeUndefined();
    expect(await kindOf(testProjectId)).toBeUndefined();
  });

  it('lets whoever may open the chat delete its test Project, and no one else', async () => {
    const chat = await newChat(creator);
    const testProjectId = await seedTestProject(chat.id);

    await expect(harness.builderChats.removeTestProject(colleague, chat.id)).rejects.toBeInstanceOf(ForbiddenException);

    await harness.builderChats.setVisibility(creator, chat.id, 'public');
    await harness.builderChats.removeTestProject(colleague, chat.id);
    expect(await kindOf(testProjectId)).toBeUndefined();
  });

  it('refuses a Project that is not a Builder chat', async () => {
    const ordinary = await harness.projects.create({ title: 'ordinary', agentId: ordinaryAgentId }, tenantId, {
      createdBy: creator.userId,
    });

    await expect(harness.builderChats.archive(creator, ordinary.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('one live test Project per chat', () => {
  it('leaves one row behind when a chat tests twice', async () => {
    const chat = await newChat(creator);
    const first = await seedTestProject(chat.id);

    await harness.builderChats.deleteTestProjectsOf(tenantId, chat.id);
    const second = await seedTestProject(chat.id);

    expect(await kindOf(first)).toBeUndefined();
    expect(await kindOf(second)).toBe('test');
  });
});

describe('the Builder Agent is not in the picker', () => {
  it('keeps it out of an ordinary project create', async () => {
    await expect(
      harness.agents.assertLiveForProjectCreate(builderAgentId, tenantId, creator.userId)
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('lets a Builder chat reach the Builder Agent by carrying its kind', async () => {
    await expect(
      harness.agents.assertLiveForProjectCreate(builderAgentId, tenantId, creator.userId, 'skill_builder_chat')
    ).resolves.toBeUndefined();
  });
});

describe('the Builder routes over HTTP', () => {
  let app: NestFastifyApplication;
  let organization: OrganizationFixture;
  let skillHolder: MemberFixture;
  let agentHolder: MemberFixture;
  let plainMember: MemberFixture;

  function request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    member: MemberFixture,
    payload?: Record<string, string>
  ) {
    return app.inject({ method, url, headers: member.headers, ...(payload === undefined ? {} : { payload }) });
  }

  async function startChat(member: MemberFixture): Promise<string> {
    const res = await request('POST', '/api/builder/chats', member, { kind: 'skill_builder_chat' });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  beforeAll(async () => {
    await ensureBuiltInAgent(BUILDER_AGENT_SLUG);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
        DomainTestModule,
        BuilderApiTestModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    organization = await createOrganization(app);
    skillHolder = await addMember(app, organization, [Perms.manageSkills]);
    agentHolder = await addMember(app, organization, [Perms.manageAgents]);
    plainMember = await addMember(app, organization, []);
  });

  afterAll(async () => {
    await app.close();
  });

  it('opens the list on either authoring permission and refuses a member holding neither', async () => {
    expect((await request('GET', '/api/builder/chats', skillHolder)).statusCode).toBe(200);
    expect((await request('GET', '/api/builder/chats', agentHolder)).statusCode).toBe(200);

    const refused = await request('GET', '/api/builder/chats', plainMember);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      message: `Missing permission: ${Perms.manageSkills} or ${Perms.manageAgents}`,
    });
  });

  it('refuses a member holding neither permission on every write route', async () => {
    const chatId = await startChat(skillHolder);

    for (const [method, url] of [
      ['POST', '/api/builder/chats'],
      ['POST', `/api/builder/chats/${chatId}/archive`],
      ['POST', `/api/builder/chats/${chatId}/restore`],
      ['DELETE', `/api/builder/chats/${chatId}`],
      ['DELETE', `/api/builder/chats/${chatId}/test-project`],
      ['POST', `/api/builder/chats/${chatId}/visibility`],
    ] as const) {
      const res = await request(
        method,
        url,
        plainMember,
        method === 'POST' ? { kind: 'skill_builder_chat' } : undefined
      );
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it('shares a chat over HTTP and opens it for the other holder', async () => {
    const chatId = await startChat(skillHolder);

    expect((await request('GET', `/api/builder/chats/${chatId}`, agentHolder)).statusCode).toBe(404);

    const shared = await request('POST', `/api/builder/chats/${chatId}/visibility`, skillHolder, {
      visibility: 'public',
    });
    expect(shared.statusCode).toBe(201);
    expect(shared.json()).toMatchObject({ visibility: 'public', canShare: true });

    const opened = await request('GET', `/api/builder/chats/${chatId}`, agentHolder);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ canOpen: true, canShare: false });

    const refused = await request('POST', `/api/builder/chats/${chatId}/visibility`, agentHolder, {
      visibility: 'private',
    });
    expect(refused.statusCode).toBe(403);
  });

  it('answers a create with the chat and a null seed prompt', async () => {
    const res = await request('POST', '/api/builder/chats', agentHolder, {
      kind: 'agent_builder_chat',
      title: 'Digest agent',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: 'agent_builder_chat',
      title: 'Digest agent',
      canOpen: true,
      disabled: false,
      seedPrompt: null,
      produced: [],
      createdBy: { id: agentHolder.userId },
    });
  });

  it('moves a chat between the active and archived filters', async () => {
    const chatId = await startChat(skillHolder);

    expect((await request('POST', `/api/builder/chats/${chatId}/archive`, agentHolder)).statusCode).toBe(201);
    expect(idsIn(await request('GET', '/api/builder/chats?filter=active', skillHolder))).not.toContain(chatId);
    expect(idsIn(await request('GET', '/api/builder/chats?filter=archived', skillHolder))).toContain(chatId);

    expect((await request('POST', `/api/builder/chats/${chatId}/restore`, agentHolder)).statusCode).toBe(201);
    expect(idsIn(await request('GET', '/api/builder/chats?filter=active', skillHolder))).toContain(chatId);
  });

  it('answers a delete with 204 and drops the chat from the list', async () => {
    const chatId = await startChat(skillHolder);

    const res = await request('DELETE', `/api/builder/chats/${chatId}`, agentHolder);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(idsIn(await request('GET', '/api/builder/chats?filter=active', skillHolder))).not.toContain(chatId);
  });

  it('lets only the creator delete the test project, and answers 204 when there is none', async () => {
    const chatId = await startChat(skillHolder);

    expect((await request('DELETE', `/api/builder/chats/${chatId}/test-project`, agentHolder)).statusCode).toBe(403);
    expect((await request('DELETE', `/api/builder/chats/${chatId}/test-project`, skillHolder)).statusCode).toBe(204);
  });

  it('answers the chat page read for the creator, 404 for another holder and 403 without a permission', async () => {
    const chatId = await startChat(skillHolder);

    const mine = await request('GET', `/api/builder/chats/${chatId}`, skillHolder);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ id: chatId, canOpen: true, kind: 'skill_builder_chat' });

    expect((await request('GET', `/api/builder/chats/${chatId}`, agentHolder)).statusCode).toBe(404);
    expect((await request('GET', `/api/builder/chats/${chatId}`, plainMember)).statusCode).toBe(403);
  });

  it('refuses an unknown filter', async () => {
    expect((await request('GET', '/api/builder/chats?filter=everything', skillHolder)).statusCode).toBe(400);
  });
});

function idsIn(response: { json: () => { id: string }[] }): string[] {
  return response.json().map((row) => row.id);
}
