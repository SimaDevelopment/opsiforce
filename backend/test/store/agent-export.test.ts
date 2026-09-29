import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { skillVersionFiles, skillVersions } from '../../db/schema';
import type { AgentExportManifest } from '../../src/agent/agent-export';
import type { AgentExportService } from '../../src/agent/agent-export.service';
import type { AgentCaller } from '../../src/agent/agent.types';
import { BUILDER_AGENT_SLUG } from '../../src/agent/agent-visibility';
import { hashSkillTree, unpackSkill, type SkillTree } from '../../src/store/gate';
import { agentTemplatesDir, ensureBuiltInAgent, ensureBuiltInSkill, seedBuilderChat } from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { manifest, validDescription } from './support/skill-fixtures';

const AWS_KEY = 'AKIAA1B2C3D4E5F6G7H8';

let harness: DomainTestHarness;
let exports: AgentExportService;
let author: AgentCaller;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  exports = harness.agentExports;

  const tenantId = await createTenantRow();
  const userId = await createUserRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  author = { tenantId, userId, canManageAgents: true };

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

async function customSkill(): Promise<{ id: string; name: string; versionId: string }> {
  const name = `skill-${randomUUID().slice(0, 8)}`;
  const skill = await harness.skills.create(
    { tenantId: author.tenantId, userId: author.userId, canManageSkills: true },
    { name, files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`) }] }
  );
  const [version] = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id));
  return { id: skill.id, name, versionId: version.id };
}

function entries(tree: SkillTree, prefix: string): SkillTree {
  return tree
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
}

async function readExport(
  agentId: string
): Promise<{ fileName: string; tree: SkillTree; manifest: AgentExportManifest }> {
  const exported = await exports.export(author, agentId);
  const tree = await unpackSkill(exported.archive);
  const manifestFile = tree.find((file) => file.path === 'manifest.json');
  if (!manifestFile) throw new Error('expected manifest.json');
  return {
    fileName: exported.fileName,
    tree,
    manifest: JSON.parse(manifestFile.content.toString('utf8')) as AgentExportManifest,
  };
}

describe('exporting a Custom Agent', () => {
  it('writes the manifest, the Development Template and one pack per pinned Custom Skill', async () => {
    const agent = await harness.agents.create(author, {
      displayName: uniqueName('Release notes'),
      description: 'Writes release notes.',
    });
    const extra = await customSkill();
    await harness.agents.setSkill(author, agent.id, extra.id, {});
    await harness.agents.updateProfile(author, agent.id, {
      promptBody: 'Write the notes.',
      model: 'openai/gpt-5.6-sol',
      variant: 'low',
    });
    await harness.agents.updateSettings(author, agent.id, { platformApi: true });
    const hash = await saveTemplate(agent.id, { 'README.md': '# Notes\n', 'scripts/check.sh': '#!/bin/sh\n' });

    const { fileName, tree, manifest: written } = await readExport(agent.id);

    expect(fileName).toBe(`${agent.name}-agent-export.zip`);
    expect(tree.map((file) => file.path).toSorted()).toEqual(
      ['manifest.json', 'template/README.md', 'template/scripts/check.sh', `skills/${extra.name}.zip`].toSorted()
    );

    const [extraVersion] = await db
      .select({ contentHash: skillVersions.contentHash })
      .from(skillVersions)
      .where(eq(skillVersions.id, extra.versionId));
    const platform = await ensureBuiltInSkill('platform');
    const [platformVersion] = await db
      .select({ contentHash: skillVersions.contentHash })
      .from(skillVersions)
      .where(eq(skillVersions.id, platform.versionId));

    expect(written).toEqual({
      kind: 'agent',
      stamp: {
        exportFormatVersion: 1,
        platformVersion: expect.any(String),
        agentImageVersion: expect.any(String),
        arch: expect.any(String),
      },
      agent: {
        displayName: agent.displayName,
        slug: agent.name,
        description: 'Writes release notes.',
        platformApi: true,
      },
      profile: { promptBody: 'Write the notes.', model: 'openai/gpt-5.6-sol', variant: 'low' },
      skills: [
        { name: 'platform', origin: 'built_in', contentHash: platformVersion.contentHash },
        {
          name: extra.name,
          origin: 'custom',
          contentHash: extraVersion.contentHash,
          file: `skills/${extra.name}.zip`,
        },
      ].toSorted((a, b) => a.name.localeCompare(b.name)),
      template: { hash },
    });

    const template = entries(tree, 'template/');
    expect(hashSkillTree(template)).toBe(hash);
    expect(template.find((file) => file.path === 'scripts/check.sh')?.executable).toBe(true);

    const pack = tree.find((file) => file.path === `skills/${extra.name}.zip`);
    const skillTree = await unpackSkill(pack?.content ?? Buffer.alloc(0));
    expect(skillTree.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(hashSkillTree(skillTree)).toBe(extraVersion.contentHash);
  });

  it('writes a null template when the Agent has none', async () => {
    const agent = await harness.agents.create(author, { displayName: uniqueName('Bare') });

    const { tree, manifest: written } = await readExport(agent.id);

    expect(written.template).toBeNull();
    expect(tree.filter((file) => file.path.startsWith('template/'))).toEqual([]);
  });

  it('refuses a damaged Development Template', async () => {
    const agent = await harness.agents.create(author, { displayName: uniqueName('Damaged') });
    const hash = await saveTemplate(agent.id, { 'README.md': 'x\n' });
    await rm(join(agentTemplatesDir(agent.id), '.versions', hash), { recursive: true, force: true });

    expect(await code(exports.export(author, agent.id))).toBe('template_damaged');
  });

  it('refuses a Template version whose files no longer match its hash', async () => {
    const agent = await harness.agents.create(author, { displayName: uniqueName('Tampered') });
    const hash = await saveTemplate(agent.id, { 'README.md': 'x\n' });
    await writeFile(join(agentTemplatesDir(agent.id), '.versions', hash, 'README.md'), 'changed\n');

    expect(await code(exports.export(author, agent.id))).toBe('template_damaged');
  });
});

describe('exporting a Built-in Agent', () => {
  it('answers not_exportable for the file and the preview', async () => {
    const builtIn = await ensureBuiltInAgent('app-builder');

    expect(await code(exports.export(author, builtIn))).toBe('not_exportable');
    expect(await code(exports.preview(author, builtIn))).toBe('not_exportable');
  });
});

describe('the export preview', () => {
  it('lists the key-like strings in the Template and the Custom Skills without refusing', async () => {
    const agent = await harness.agents.create(author, { displayName: uniqueName('Leaky') });
    const leaky = await customSkill();
    await harness.agents.setSkill(author, agent.id, leaky.id, {});
    const clean = await customSkill();
    await harness.agents.setSkill(author, agent.id, clean.id, {});
    await db
      .update(skillVersionFiles)
      .set({ content: Buffer.from(`${manifest(`name: ${leaky.name}\ndescription: ${validDescription}`)}${AWS_KEY}\n`) })
      .where(and(eq(skillVersionFiles.versionId, leaky.versionId), eq(skillVersionFiles.path, 'SKILL.md')));
    await saveTemplate(agent.id, { 'README.md': '# Readme\n', 'app/config.js': `export const key = '${AWS_KEY}';\n` });

    const preview = await exports.preview(author, agent.id);

    expect(preview.template).toEqual([{ path: 'app/config.js', reason: expect.stringContaining('line 1') }]);
    expect(preview.skills).toEqual([{ name: leaky.name, hits: [{ path: 'SKILL.md', reason: expect.any(String) }] }]);
    await expect(exports.export(author, agent.id)).resolves.toMatchObject({
      fileName: `${agent.name}-agent-export.zip`,
    });
  });

  it('is empty for a clean Agent', async () => {
    const agent = await harness.agents.create(author, { displayName: uniqueName('Clean') });
    await saveTemplate(agent.id, { 'README.md': '# Readme\n' });

    expect(await exports.preview(author, agent.id)).toEqual({ template: [], skills: [] });
  });
});
