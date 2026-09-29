import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { agentProfiles, agentSettings, agents, environments, projects } from '../../db/schema';
import { BUILDER_AGENT_SLUG } from '../../src/agent/agent-visibility';
import { DEFAULT_AGENT_NAME, type AgentCaller } from '../../src/agent/agent.types';
import type { BuilderChatCaller } from '../../src/builder/builder.types';
import { TEST_PROJECT_KIND } from '../../src/project/project.types';
import { hashSkillTree } from '../../src/store/gate';
import { readSkillTree } from '../../src/store/skill-tree';
import {
  agentTemplatesDir,
  defaultEnvironmentId,
  ensureBuiltInAgent,
  ensureBuiltInSkill,
  seedBuilderChat,
  seedLiveAgent,
  seedWorkspaceProject,
  type SeededAgent,
} from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const PLATFORM_ENTRIES = ['.opencode', '.opsiforce'];

let harness: DomainTestHarness;
let tenantId: string;
let userId: string;
let author: AgentCaller;
let chatCaller: BuilderChatCaller;
let developmentId: string;
let productionId: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  tenantId = await createTenantRow();
  userId = await createUserRow();
  author = { tenantId, userId, canManageAgents: true };
  chatCaller = { tenantId, userId, canManageAgents: true, canManageSkills: true };
  await harness.environments.ensureDefaultForTenant(tenantId);
  await ensureBuiltInSkill('platform');
  await ensureBuiltInAgent(BUILDER_AGENT_SLUG);
  developmentId = await defaultEnvironmentId(tenantId);
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(eq(environments.tenantId, tenantId), eq(environments.isDefault, false), eq(environments.isProtected, true))
    );
  productionId = production.id;
});

afterAll(async () => {
  await harness.close();
});

function workspaceDir(projectId: string): string {
  return join(storageMountPath, 'projects', projectId);
}

async function agentOnProduction(): Promise<SeededAgent> {
  const agent = await seedLiveAgent(tenantId, userId);
  await db
    .insert(agentProfiles)
    .values({ id: randomUUID(), agentId: agent.id, environmentId: productionId, promptBody: 'Released.' });
  await db.update(agentSettings).set({ defaultEnvironmentId: productionId }).where(eq(agentSettings.agentId, agent.id));
  return agent;
}

async function saveDevelopmentTemplate(agentId: string, files: Record<string, string>): Promise<string> {
  const { chatId, templateDir } = await seedBuilderChat(tenantId, agentId, userId);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(templateDir, path)), { recursive: true });
    await writeFile(join(templateDir, path), content);
    if (path.endsWith('.sh')) await chmod(join(templateDir, path), 0o755);
  }
  const saved = await harness.agents.saveTemplate(author, agentId, chatId);
  await db.update(agents).set({ builderChatId: null }).where(eq(agents.id, agentId));
  if (!saved.hash) throw new Error('expected a saved Template');
  return saved.hash;
}

async function linkProduction(agentId: string, hash: string): Promise<void> {
  await symlink(join('.versions', hash), join(agentTemplatesDir(agentId), productionId));
}

async function templateHashAt(agentId: string, environmentId: string): Promise<string | undefined> {
  const detail = await harness.agents.findOne(author, agentId);
  return detail.profiles.find((profile) => profile.environmentId === environmentId)?.template?.hash;
}

function laidTree(directory: string) {
  return readSkillTree(directory).filter(
    (file) => !PLATFORM_ENTRIES.some((entry) => file.path.startsWith(`${entry}/`))
  );
}

async function projectCountOf(agentId: string): Promise<number> {
  return (await db.select({ id: projects.id }).from(projects).where(eq(projects.agentId, agentId))).length;
}

function createProject(agentId: string) {
  return harness.projects.create({ agentId }, tenantId, { createdBy: userId });
}

function createTestProject(agentId: string) {
  return harness.projects.create({ agentId }, tenantId, { createdBy: userId, kind: TEST_PROJECT_KIND });
}

describe('laying a Custom Agent’s Template at Project create (ADR-0073)', () => {
  let agent: SeededAgent;

  beforeAll(async () => {
    agent = await agentOnProduction();
    const released = await saveDevelopmentTemplate(agent.id, {
      'README.md': '# Released\n',
      'app/startup.sh': '#!/bin/sh\necho released\n',
    });
    await linkProduction(agent.id, released);
    await saveDevelopmentTemplate(agent.id, { 'README.md': '# Draft\n', 'notes/todo.md': 'next\n' });
  });

  it('gives an ordinary Project the Default environment’s version, hashing to that Environment’s hash', async () => {
    const project = await createProject(agent.id);

    const laid = laidTree(workspaceDir(project.id));
    expect(laid.map((file) => file.path).toSorted()).toEqual(['README.md', 'app/startup.sh']);
    expect(laid.find((file) => file.path === 'app/startup.sh')?.executable).toBe(true);
    expect(hashSkillTree(laid)).toBe(await templateHashAt(agent.id, productionId));
  });

  it('gives a Test Project Development’s version', async () => {
    const project = await createTestProject(agent.id);

    const laid = laidTree(workspaceDir(project.id));
    expect(laid.map((file) => file.path).toSorted()).toEqual(['README.md', 'notes/todo.md']);
    expect(hashSkillTree(laid)).toBe(await templateHashAt(agent.id, developmentId));
  });

  it('still writes the prompt beside the Template', async () => {
    const project = await createProject(agent.id);

    expect(
      readSkillTree(join(workspaceDir(project.id), '.opencode/agents'))
        .map((file) => file.path)
        .toSorted()
    ).toEqual([`${agent.name}.md`]);
  });
});

describe('a create that cannot lay its Template', () => {
  it('fails on a link to a missing version and leaves no Project', async () => {
    const agent = await agentOnProduction();
    await mkdir(agentTemplatesDir(agent.id), { recursive: true });
    await linkProduction(agent.id, 'f'.repeat(64));

    await expect(createProject(agent.id)).rejects.toThrow(/missing/);
    expect(await projectCountOf(agent.id)).toBe(0);
  });

  it('fails when the copy never matches its hash and leaves no Project', async () => {
    const agent = await seedLiveAgent(tenantId, userId);
    const hash = await saveDevelopmentTemplate(agent.id, { 'README.md': '# Intact\n' });
    await writeFile(join(agentTemplatesDir(agent.id), '.versions', hash, 'README.md'), '# Tampered\n');
    const before = await projectCountOf(agent.id);

    await expect(createTestProject(agent.id)).rejects.toThrow(/intact/);
    expect(await projectCountOf(agent.id)).toBe(before);
  });

  it('lays nothing when the Environment has no Template', async () => {
    const agent = await seedLiveAgent(tenantId, userId);
    const project = await createProject(agent.id);

    expect(laidTree(workspaceDir(project.id))).toEqual([]);
  });
});

describe('a Built-in Agent’s create', () => {
  it('is unchanged: the backend writes nothing outside the platform folders', async () => {
    const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
    await db
      .insert(agentProfiles)
      .values({ id: randomUUID(), agentId, environmentId: developmentId })
      .onConflictDoNothing({ target: [agentProfiles.agentId, agentProfiles.environmentId] });

    const project = await createProject(agentId);

    const entries = await readdir(workspaceDir(project.id));
    expect(entries.filter((entry) => !PLATFORM_ENTRIES.includes(entry))).toEqual([]);
  });
});

describe('a fresh Builder chat on an Agent', () => {
  it('opens with the Agent’s Development Template in template/', async () => {
    const agent = await seedLiveAgent(tenantId, userId);
    const hash = await saveDevelopmentTemplate(agent.id, { 'README.md': '# Inherited\n', 'app/index.html': '<p>' });

    const chat = await harness.builderChats.openFor(chatCaller, { agentId: agent.id });

    const template = readSkillTree(join(workspaceDir(chat.id), 'template'));
    expect(template.map((file) => file.path).toSorted()).toEqual(['README.md', 'app/index.html']);
    expect(hashSkillTree(template)).toBe(hash);
  });

  it('opens with no template/ when the Agent has no Template', async () => {
    const agent = await seedLiveAgent(tenantId, userId);

    const chat = await harness.builderChats.openFor(chatCaller, { agentId: agent.id });

    expect(existsSync(join(workspaceDir(chat.id), 'template'))).toBe(false);
  });

  it('discards a chat that loses the claim, with its copy', async () => {
    const agent = await seedLiveAgent(tenantId, userId);
    await saveDevelopmentTemplate(agent.id, { 'README.md': '# Contested\n' });
    const winnerId = await seedWorkspaceProject(tenantId, {
      agentId: agent.id,
      createdBy: userId,
      kind: 'agent_builder_chat',
    });

    const create = harness.projects.create.bind(harness.projects);
    const losers: string[] = [];
    const spy = vi.spyOn(harness.projects, 'create').mockImplementationOnce(async (...args) => {
      const created = await create(...args);
      losers.push(created.id);
      await db.update(agents).set({ builderChatId: winnerId }).where(eq(agents.id, agent.id));
      return created;
    });

    try {
      const chat = await harness.builderChats.openFor(chatCaller, { agentId: agent.id });

      expect(chat.id).toBe(winnerId);
      expect(losers).toHaveLength(1);
      expect(await db.select().from(projects).where(eq(projects.id, losers[0]))).toEqual([]);
      expect(existsSync(workspaceDir(losers[0]))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
