import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { agentProfiles, agents, environments } from '../../db/schema';
import { BUILDER_AGENT_SLUG } from '../../src/agent/agent-visibility';
import type { AgentCaller, AgentDetail } from '../../src/agent/agent.types';
import type { BuilderChatCaller } from '../../src/builder/builder.types';
import { hashSkillTree } from '../../src/store/gate';
import { agentConfigRoot, readSkillTree } from '../../src/store/skill-tree';
import {
  agentTemplateFolders,
  agentTemplatesDir,
  defaultEnvironmentId,
  ensureBuiltInAgent,
  ensureBuiltInSkill,
  seedBuilderChat,
  templateSourceHash,
  withNewerBuiltInVersion,
} from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { manifest, validDescription } from './support/skill-fixtures';

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';

let harness: DomainTestHarness;
let author: AgentCaller;
let chatCaller: BuilderChatCaller;
let developmentId: string;
let productionId: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();

  const tenantId = await createTenantRow();
  const userId = await createUserRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  author = { tenantId, userId, canManageAgents: true };
  chatCaller = { tenantId, userId, canManageAgents: true, canManageSkills: true };
  developmentId = await defaultEnvironmentId(tenantId);
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, false)))
    .limit(1);
  productionId = production.id;

  await ensureBuiltInSkill('platform');
  await ensureBuiltInAgent(BUILDER_AGENT_SLUG);
});

afterAll(async () => {
  await harness.close();
});

function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

async function code(action: Promise<unknown>): Promise<string> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught
  );
  const response = (error as { getResponse?: () => unknown } | null)?.getResponse?.();
  return (response as { code?: string } | undefined)?.code ?? String(error);
}

function development(detail: AgentDetail) {
  const profile = detail.profiles.find((candidate) => candidate.environmentId === developmentId);
  if (!profile) throw new Error('expected a Development profile');
  return profile;
}

function pinnedNames(detail: AgentDetail): string[] {
  return (development(detail).skills ?? []).map((skill) => skill.name).toSorted();
}

async function saveTemplate(agentId: string, files: Record<string, string>): Promise<string> {
  const { chatId, templateDir } = await seedBuilderChat(author.tenantId, agentId, author.userId);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(templateDir, path)), { recursive: true });
    await writeFile(join(templateDir, path), content);
    if (path.endsWith('.sh')) await chmod(join(templateDir, path), 0o755);
  }
  const saved = await harness.agents.saveTemplate(author, agentId, chatId);
  if (!saved.hash) throw new Error('expected a saved Template');
  return saved.hash;
}

async function customSkill(): Promise<{ id: string; name: string }> {
  const name = `skill-${randomUUID().slice(0, 8)}`;
  const skill = await harness.skills.create(
    { tenantId: author.tenantId, userId: author.userId, canManageSkills: true },
    { name, files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`) }] }
  );
  return { id: skill.id, name };
}

async function productionProfileCount(agentId: string): Promise<number> {
  const rows = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, productionId)));
  return rows.length;
}

function packageDirectory(...segments: string[]): string {
  const privatePath = join(agentConfigRoot(), 'private', 'agents', ...segments);
  return existsSync(privatePath) ? privatePath : join(agentConfigRoot(), 'agents', ...segments);
}

function promptBody(packageName: string): string {
  const text = readFileSync(packageDirectory(packageName, 'agent.md'), 'utf8');
  return text.slice(text.indexOf('\n---', 3) + 4).trim();
}

describe('duplicating a Custom Agent', () => {
  it('carries its description, prompt, model, Skills, platform_api and Template, with the same hash', async () => {
    const source = await harness.agents.create(author, {
      displayName: uniqueName('Source'),
      description: 'Writes release notes.',
    });
    const extra = await customSkill();
    await harness.agents.setSkill(author, source.id, extra.id, {});
    await harness.agents.updateProfile(author, source.id, {
      promptBody: 'Write the notes.',
      model: 'openai/gpt-5.6-sol',
      variant: 'low',
    });
    await harness.agents.updateSettings(author, source.id, { platformApi: true });
    const hash = await saveTemplate(source.id, { 'README.md': '# Notes\n', 'scripts/check.sh': '#!/bin/sh\n' });
    const sourcePins = (development(await harness.agents.findOne(author, source.id)).skills ?? []).map(
      (skill) => skill.pinnedVersionId
    );

    const copy = await harness.agents.duplicate(author, source.id, { displayName: uniqueName('Copy') });

    expect(copy).toMatchObject({
      origin: 'custom',
      visibility: 'private',
      description: 'Writes release notes.',
      createdBy: author.userId,
      builderChatId: null,
      defaultEnvironmentId: productionId,
      settings: { platformApi: true, defaultEnvironmentId: productionId },
    });
    expect(development(copy)).toMatchObject({
      promptBody: 'Write the notes.',
      model: 'openai/gpt-5.6-sol',
      variant: 'low',
      template: { hash, damaged: false },
    });
    expect(pinnedNames(copy)).toEqual(['platform', extra.name].toSorted());
    expect((development(copy).skills ?? []).map((skill) => skill.pinnedVersionId).toSorted()).toEqual(
      sourcePins.toSorted()
    );
    expect(await productionProfileCount(copy.id)).toBe(0);
    const [row] = await db.select({ poolSize: agents.poolSize }).from(agents).where(eq(agents.id, copy.id));
    expect(row.poolSize).toBe(0);
  });

  it('keeps the source’s platform Version when a newer one has shipped since', async () => {
    const source = await harness.agents.create(author, { displayName: uniqueName('Pinned platform') });

    await withNewerBuiltInVersion('platform', async ({ olderVersionId }) => {
      const copy = await harness.agents.duplicate(author, source.id, { displayName: uniqueName('Platform copy') });

      const platform = (development(copy).skills ?? []).filter((skill) => skill.name === 'platform');
      expect(platform.map((skill) => skill.pinnedVersionId)).toEqual([olderVersionId]);
    });
  });

  it('opens its first Builder chat with the inherited Template', async () => {
    const source = await harness.agents.create(author, { displayName: uniqueName('Seeded') });
    const hash = await saveTemplate(source.id, { 'app/index.html': '<p>starter</p>\n' });
    const copy = await harness.agents.duplicate(author, source.id, { displayName: uniqueName('Seeded copy') });

    const chat = await harness.builderChats.openFor(chatCaller, { agentId: copy.id });

    const template = readSkillTree(join(storageMountPath, 'projects', chat.id, 'template'));
    expect(template.map((file) => file.path)).toEqual(['app/index.html']);
    expect(hashSkillTree(template)).toBe(hash);
  });

  it('refuses a source whose Development Template is damaged', async () => {
    const source = await harness.agents.create(author, { displayName: uniqueName('Damaged') });
    const hash = await saveTemplate(source.id, { 'README.md': 'x\n' });
    await rm(join(agentTemplatesDir(source.id), '.versions', hash), { recursive: true, force: true });

    expect(await code(harness.agents.duplicate(author, source.id, { displayName: uniqueName('Nope') }))).toBe(
      'template_damaged'
    );
  });

  it('refuses a taken name and a reserved Built-in slug before writing anything', async () => {
    const source = await harness.agents.create(author, { displayName: uniqueName('Named') });

    expect(await code(harness.agents.duplicate(author, source.id, { displayName: source.displayName ?? '' }))).toBe(
      'name_unavailable'
    );
    expect(await code(harness.agents.duplicate(author, source.id, { displayName: 'App Builder' }))).toBe(
      'name_unavailable'
    );
  });

  it('removes the new Template at once when the row transaction fails', async () => {
    const source = await harness.agents.create(author, { displayName: uniqueName('Rollback') });
    await saveTemplate(source.id, { 'README.md': 'rollback\n' });
    const foldersBefore = agentTemplateFolders();
    const transactionSpy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('transaction failed'));
    const displayName = uniqueName('Rolled back');

    try {
      await expect(harness.agents.duplicate(author, source.id, { displayName })).rejects.toThrow('transaction failed');
    } finally {
      transactionSpy.mockRestore();
    }

    expect(agentTemplateFolders()).toEqual(foldersBefore);
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.displayName, displayName));
    expect(rows).toEqual([]);
  });
});

describe('duplicating a Built-in Agent', () => {
  it('gives App Builder’s prompt body, registry model, shipped Skills, parked pins and package template', async () => {
    const builtIn = await ensureBuiltInAgent('app-builder');
    const webApp = await ensureBuiltInSkill('web-app');
    await ensureBuiltInSkill('ui');
    const parked = await ensureBuiltInSkill('makara-ui');
    await harness.agents.setSkill(author, builtIn, parked.skillId, {});

    const copy = await harness.agents.duplicate(author, builtIn, { displayName: uniqueName('Branded') });

    const profile = development(copy);
    expect(profile.promptBody).toBe(promptBody('app-builder'));
    expect(profile.promptBody?.startsWith('---')).toBe(false);
    expect(profile).toMatchObject({ model: 'openai/gpt-5.6-sol', variant: 'high' });
    expect(pinnedNames(copy)).toEqual(expect.arrayContaining(['platform', 'ui', 'web-app', 'makara-ui']));
    expect(profile.skills?.find((skill) => skill.name === 'web-app')?.pinnedVersionId).toBe(webApp.versionId);
    expect(copy).toMatchObject({ origin: 'custom', visibility: 'private', defaultEnvironmentId: productionId });

    const packageHash = await templateSourceHash(packageDirectory('app-builder', 'template'));
    expect(profile.template).toEqual({ hash: packageHash, damaged: false });
  });

  it('leaves the Skills Makara doesn’t ship off a Makara copy', async () => {
    const builtIn = await ensureBuiltInAgent('makara-app-builder');
    await ensureBuiltInSkill('web-app');
    await ensureBuiltInSkill('dates');
    await ensureBuiltInSkill('makara-dates');

    const copy = await harness.agents.duplicate(author, builtIn, { displayName: uniqueName('Makara copy') });

    const profile = development(copy);
    expect(profile.promptBody).toBe(promptBody('makara-app-builder'));
    expect(pinnedNames(copy)).toContain('makara-dates');
    expect(pinnedNames(copy)).not.toContain('web-app');
    expect(pinnedNames(copy)).not.toContain('dates');
    expect(profile.template?.hash).toBe(await templateSourceHash(packageDirectory('makara-app-builder', 'template')));
  });

  it('refuses the Skill & Agent Builder and marks it not duplicable', async () => {
    const builder = await ensureBuiltInAgent(BUILDER_AGENT_SLUG);

    expect(await code(harness.agents.duplicate(author, builder, { displayName: uniqueName('Builder') }))).toBe(
      'not_duplicable'
    );
    expect((await harness.agents.findOne(author, builder)).duplicable).toBe(false);
    expect((await harness.agents.findOne(author, await ensureBuiltInAgent('app-builder'))).duplicable).toBe(true);
  });
});
