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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { agents, projects, skills, tenantDisabledSkills } from '../db/schema';
import { BUILDER_AGENT_SLUG } from '../src/agent/agent-visibility';
import { BuilderController } from '../src/builder/builder.controller';
import type { BuilderChatCaller } from '../src/builder/builder.types';
import { configuration } from '../src/config/configuration';
import { ProjectExportController } from '../src/export/project-export.controller';
import type { ProjectExportService } from '../src/export/project-export.service';
import { MissingPermissionException } from '../src/permission/missing-permission.exception';
import { Perms } from '../src/permission/permission.constants';
import { PermissionGuard } from '../src/permission/permission.guard';
import type { ProjectEventsService } from '../src/project/project-events.service';
import { isProjectAccessible } from '../src/project/project-visibility';
import type { TenantContext } from '../src/tenant/tenant.decorator';
import { TenantGuard } from '../src/tenant/tenant.guard';
import type { UserContext } from '../src/user/user.decorator';
import type { UserService } from '../src/user/user.service';
import { ensureBuiltInAgent, seedLiveAgent } from './support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';
import { DomainTestModule } from './support/domain-module';
import { createUserRow } from './support/org-fixtures';
import {
  addMember,
  createTenant,
  type MemberFixture,
  type TenantFixture,
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

function callerFor(userId: string): BuilderChatCaller {
  return { tenantId, userId, canManageSkills: true, canManageAgents: true };
}

beforeAll(async () => {
  harness = await createDomainTestingModule();
  builderAgentId = await ensureBuiltInAgent(BUILDER_AGENT_SLUG);

  const tenant = await harness.tenants.getOrCreateTenant(`builder-${randomUUID()}`);
  tenantId = tenant.id;
  await harness.environments.ensureDefaultForTenant(tenantId);

  creator = callerFor(await createUserRow());
  colleague = callerFor(await createUserRow());
});

afterAll(async () => {
  await harness.close();
});

async function seedSkill(options: { visibility?: 'private' | 'public'; disabled?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(skills).values({
    id,
    tenantId,
    origin: 'custom',
    name: `skill-${id.slice(0, 8)}`,
    visibility: options.visibility ?? 'private',
    createdBy: creator.userId,
  });
  if (options.disabled) await db.insert(tenantDisabledSkills).values({ tenantId, skillId: id });
  return id;
}

async function seedAgent(visibility: 'private' | 'public' = 'private'): Promise<string> {
  return (await seedLiveAgent(tenantId, creator.userId, { visibility })).id;
}

async function seedTestProject(chatId: string, agentId: string): Promise<string> {
  const project = await harness.projects.create({ title: `test-${randomUUID().slice(0, 8)}`, agentId }, tenantId, {
    createdBy: creator.userId,
    createdByProjectId: chatId,
    kind: 'test',
  });
  return project.id;
}

async function kindOf(projectId: string): Promise<string | null | undefined> {
  const [row] = await db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, projectId));
  return row?.kind;
}

async function builderChatOfAgent(agentId: string): Promise<string | null> {
  const [row] = await db.select({ chat: agents.builderChatId }).from(agents).where(eq(agents.id, agentId));
  return row?.chat ?? null;
}

describe('opening the Builder on a Skill or an Agent', () => {
  it('makes one chat on first opening, stamped for the subject, and links the subject to it', async () => {
    const agentId = await seedAgent();

    const chat = await harness.builderChats.openFor(creator, { agentId });

    const [row] = await db.select().from(projects).where(eq(projects.id, chat.id));
    expect(row).toMatchObject({
      kind: 'agent_builder_chat',
      agentId: builderAgentId,
      workspaceId: null,
      createdBy: creator.userId,
    });
    expect(chat.subject).toMatchObject({ type: 'agent', id: agentId, disabled: false });
    expect(await builderChatOfAgent(agentId)).toBe(chat.id);
  });

  it('returns the same chat on every later opening', async () => {
    const skillId = await seedSkill();

    const first = await harness.builderChats.openFor(creator, { skillId });
    const again = await harness.builderChats.openFor(creator, { skillId });

    expect(again.id).toBe(first.id);
    expect(again.kind).toBe('skill_builder_chat');
  });

  it('settles two first openings on one chat and leaves no loser behind', async () => {
    const skillId = await seedSkill();

    const [left, right] = await Promise.all([
      harness.builderChats.openFor(creator, { skillId }),
      harness.builderChats.openFor(creator, { skillId }),
    ]);

    expect(left.id).toBe(right.id);
    const [skill] = await db
      .select({ name: skills.name, chat: skills.builderChatId })
      .from(skills)
      .where(eq(skills.id, skillId));
    expect(skill.chat).toBe(left.id);
    const chats = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.title, `Builder: ${skill.name}`));
    expect(chats.map((row) => row.id)).toEqual([left.id]);
  });

  it('refuses a subject the caller cannot see', async () => {
    const skillId = await seedSkill();

    await expect(harness.builderChats.openFor(colleague, { skillId })).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness.builderChats.openFor(creator, { skillId: randomUUID() })).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('refuses a Built-in Agent, which the agent image owns', async () => {
    await expect(harness.builderChats.openFor(creator, { agentId: builderAgentId })).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('asks for the permission that matches the subject', async () => {
    const skillId = await seedSkill();
    const agentId = await seedAgent();

    await expect(
      harness.builderChats.openFor({ ...creator, canManageSkills: false }, { skillId })
    ).rejects.toBeInstanceOf(MissingPermissionException);
    await expect(
      harness.builderChats.openFor({ ...creator, canManageAgents: false }, { agentId })
    ).rejects.toBeInstanceOf(MissingPermissionException);
  });

  it('turns a disabled chat back on when its enabled subject opens it', async () => {
    const skillId = await seedSkill();
    const chat = await harness.builderChats.openFor(creator, { skillId });
    await harness.projects.disable(chat.id, tenantId);

    expect((await harness.builderChats.openFor(creator, { skillId })).disabled).toBe(false);
  });

  it('opens no new chat for a disabled subject', async () => {
    const skillId = await seedSkill({ disabled: true });

    await expect(harness.builderChats.openFor(creator, { skillId })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a request naming neither an agent nor a skill', async () => {
    await expect(harness.builderChats.openFor(creator, {} as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('who reaches a chat', () => {
  it('follows the subject: private to its creator, then everyone once it is public', async () => {
    const agentId = await seedAgent('private');
    const chat = await harness.builderChats.openFor(creator, { agentId });
    const testProjectId = await seedTestProject(chat.id, agentId);

    expect(await isProjectAccessible(tenantId, colleague.userId, chat.id)).toBe(false);
    expect(await isProjectAccessible(tenantId, colleague.userId, testProjectId)).toBe(false);

    await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, agentId));

    expect(await isProjectAccessible(tenantId, colleague.userId, chat.id)).toBe(true);
    expect(await isProjectAccessible(tenantId, colleague.userId, testProjectId)).toBe(true);
    expect((await harness.builderChats.openFor(colleague, { agentId })).id).toBe(chat.id);
  });

  it('leaves a chat whose subject is gone reachable by its creator alone', async () => {
    const skillId = await seedSkill({ visibility: 'public' });
    const chat = await harness.builderChats.openFor(creator, { skillId });
    await db.update(skills).set({ builderChatId: null }).where(eq(skills.id, skillId));

    expect(await isProjectAccessible(tenantId, creator.userId, chat.id)).toBe(true);
    expect(await isProjectAccessible(tenantId, colleague.userId, chat.id)).toBe(false);
  });

  it('keeps a chat out of the ordinary Project list', async () => {
    const skillId = await seedSkill({ visibility: 'public' });
    const chat = await harness.builderChats.openFor(creator, { skillId });

    const listed = await harness.projects.findAllForUser({ tenantId, userId: colleague.userId });

    expect(listed.map((row) => row.id)).not.toContain(chat.id);
  });
});

describe('starting over and deleting', () => {
  it('deletes the chat and its test Project like any Project, and the next opening starts a fresh one', async () => {
    const agentId = await seedAgent();
    const chat = await harness.builderChats.openFor(creator, { agentId });
    const testProjectId = await seedTestProject(chat.id, agentId);

    await harness.projects.remove(chat.id, tenantId);

    expect(await kindOf(chat.id)).toBeUndefined();
    expect(await kindOf(testProjectId)).toBeUndefined();
    expect(await builderChatOfAgent(agentId)).toBeNull();
    expect((await harness.builderChats.openFor(creator, { agentId })).id).not.toBe(chat.id);
  });

  it('deletes the test Project alone and keeps the chat', async () => {
    const agentId = await seedAgent();
    const chat = await harness.builderChats.openFor(creator, { agentId });
    const testProjectId = await seedTestProject(chat.id, agentId);

    await harness.projects.remove(testProjectId, tenantId);

    expect(await kindOf(testProjectId)).toBeUndefined();
    expect(await kindOf(chat.id)).toBe('agent_builder_chat');
    expect((await harness.builderChats.openFor(creator, { agentId })).testProject).toBeUndefined();
  });

  it('refuses to duplicate a chat, which would belong to nothing', async () => {
    const skillId = await seedSkill();
    const chat = await harness.builderChats.openFor(creator, { skillId });

    await expect(harness.projects.duplicate(chat.id, tenantId, undefined, creator.userId)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('refuses to duplicate a test Project, which would be a second live one for its chat', async () => {
    const agentId = await seedAgent();
    const chat = await harness.builderChats.openFor(creator, { agentId });
    const testProjectId = await seedTestProject(chat.id, agentId);

    await expect(harness.projects.duplicate(testProjectId, tenantId, undefined, creator.userId)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('refuses to export a chat, which would belong to nothing', async () => {
    const skillId = await seedSkill();
    const chat = await harness.builderChats.openFor(creator, { skillId });
    const startExport = vi.fn();
    const controller = new ProjectExportController(
      { startExport } as unknown as ProjectExportService,
      harness.projects,
      {} as ProjectEventsService,
      { resolveUserId: () => Promise.resolve(creator.userId) } as unknown as UserService
    );

    await expect(controller.start(chat.id, { tenantId } as TenantContext, {} as UserContext)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(startExport).not.toHaveBeenCalled();
  });
});

describe('one Test Project per chat', () => {
  it("names the chat's Test Project, and nothing for a chat without one or for a Test Project itself", async () => {
    const agentId = await seedAgent();
    const chat = await harness.builderChats.openFor(creator, { agentId });
    expect(await harness.builderChats.testProjectOf(tenantId, chat.id)).toBeNull();

    const testProjectId = await seedTestProject(chat.id, agentId);

    expect(await harness.builderChats.testProjectOf(tenantId, chat.id)).toEqual({ id: testProjectId });
    expect(await harness.builderChats.testProjectOf(tenantId, testProjectId)).toBeNull();
    expect((await harness.builderChats.openFor(creator, { agentId })).testProject?.id).toBe(testProjectId);
  });
});

describe('what a chat pod reads about its subject', () => {
  it('names the subject for the chat, and nothing for any other Project', async () => {
    const skillId = await seedSkill();
    const chat = await harness.builderChats.openFor(creator, { skillId });
    const agentId = await seedAgent();
    const ordinary = await harness.projects.create({ title: 'ordinary', agentId }, tenantId, {
      createdBy: creator.userId,
    });

    expect(await harness.builderChats.subjectOfChat(tenantId, creator.userId, chat.id)).toMatchObject({
      type: 'skill',
      id: skillId,
    });
    expect(await harness.builderChats.subjectOfChat(tenantId, creator.userId, ordinary.id)).toBeNull();
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
  let tenant: TenantFixture;
  let skillHolder: MemberFixture;
  let agentHolder: MemberFixture;
  let plainMember: MemberFixture;

  function request(method: 'POST', url: string, member: MemberFixture, payload?: Record<string, string>) {
    return app.inject({ method, url, headers: member.headers, ...(payload === undefined ? {} : { payload }) });
  }

  async function skillOf(member: MemberFixture): Promise<string> {
    const id = randomUUID();
    await db.insert(skills).values({
      id,
      tenantId: tenant.tenantId,
      origin: 'custom',
      name: `skill-${id.slice(0, 8)}`,
      visibility: 'private',
      createdBy: member.userId,
    });
    return id;
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

    tenant = await createTenant(app);
    skillHolder = await addMember(app, tenant, [Perms.manageSkills]);
    agentHolder = await addMember(app, tenant, [Perms.manageAgents]);
    plainMember = await addMember(app, tenant, []);
  });

  afterAll(async () => {
    await app.close();
  });

  it('opens a chat with 200 and answers the same chat again', async () => {
    const skillId = await skillOf(skillHolder);

    const first = await request('POST', '/api/builder/chats', skillHolder, { skillId });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ kind: 'skill_builder_chat', subject: { type: 'skill', id: skillId } });

    const again = await request('POST', '/api/builder/chats', skillHolder, { skillId });
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
  });

  it('refuses a holder of the other permission, and a member holding neither', async () => {
    const skillId = await skillOf(skillHolder);

    expect((await request('POST', '/api/builder/chats', agentHolder, { skillId })).statusCode).toBe(403);

    const refused = await request('POST', '/api/builder/chats', plainMember, { skillId });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      message: `Missing permission: ${Perms.manageSkills} or ${Perms.manageAgents}`,
    });
  });
});
