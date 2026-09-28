import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentCaller, AgentDetail } from '../../src/agent/agent.types';
import type { AgentService } from '../../src/agent/agent.service';
import { hashSkillTree } from '../../src/store/gate';
import { readSkillTree } from '../../src/store/skill-tree';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import {
  agentTemplatesDir,
  defaultEnvironmentId,
  ensureBuiltInSkill,
  seedBuilderChat,
} from '../support/agent-fixtures';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

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

let harness: DomainTestHarness;
let service: AgentService;
let author: AgentCaller;
let developmentId: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  service = harness.agents;
  const tenantId = await createTenantRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  author = { tenantId, userId: await createUserRow(), canManageAgents: true };
  developmentId = await defaultEnvironmentId(tenantId);
  await ensureBuiltInSkill('platform');
});

afterAll(async () => {
  await harness.close();
});

interface Authoring {
  agentId: string;
  chatId: string;
  templateDir: string;
  write: (path: string, content?: string) => Promise<void>;
  save: () => ReturnType<AgentService['saveTemplate']>;
  developmentTemplate: () => Promise<AgentDetail['profiles'][number]['template']>;
}

async function authoring(): Promise<Authoring> {
  const agent = await service.create(author, { displayName: `Template ${randomUUID().slice(0, 8)}` });
  const { chatId, templateDir } = await seedBuilderChat(author.tenantId, agent.id, author.userId);
  return {
    agentId: agent.id,
    chatId,
    templateDir,
    write: async (path, content = `${path}\n`) => {
      await mkdir(dirname(join(templateDir, path)), { recursive: true });
      await writeFile(join(templateDir, path), content);
    },
    save: () => service.saveTemplate(author, agent.id, chatId),
    developmentTemplate: async () => {
      const detail = await service.findOne(author, agent.id);
      return detail.profiles.find((profile) => profile.environmentId === developmentId)?.template ?? null;
    },
  };
}

function hashOf(saved: { hash: string | null }): string {
  if (!saved.hash) throw new Error('expected a saved Template');
  return saved.hash;
}

function versionDir(agentId: string, hash: string): string {
  return join(agentTemplatesDir(agentId), '.versions', hash);
}

async function versionsOf(agentId: string): Promise<string[]> {
  try {
    return (await readdir(join(agentTemplatesDir(agentId), '.versions'))).toSorted();
  } catch {
    return [];
  }
}

async function refusalOf(work: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  );
  const http = error as { getStatus: () => number; getResponse: () => Record<string, unknown> };
  return { status: http.getStatus(), body: http.getResponse() };
}

describe('saving a Template from the Builder chat (ADR-0073)', () => {
  it('mirrors template/ into Development, and a deleted file leaves the Template', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    await draft.write('reference/brand.md');

    const first = await draft.save();
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.files).toEqual([
      { path: 'README.md', size: 10, executable: false },
      { path: 'reference/brand.md', size: 19, executable: false },
    ]);
    expect(await draft.developmentTemplate()).toEqual({ hash: first.hash, damaged: false });

    await rm(join(draft.templateDir, 'reference/brand.md'));
    const second = await draft.save();

    expect(second.hash).not.toBe(first.hash);
    expect(second.files.map((file) => file.path)).toEqual(['README.md']);
    expect(readSkillTree(versionDir(draft.agentId, hashOf(second))).map((file) => file.path)).toEqual(['README.md']);
    expect(await versionsOf(draft.agentId)).toEqual([second.hash]);
    expect(await draft.developmentTemplate()).toEqual({ hash: second.hash, damaged: false });
  });

  it('names a version by the Skill-tree hash of what it holds', async () => {
    const draft = await authoring();
    await draft.write('app/startup.sh', '#!/bin/sh\necho up\n');
    await chmod(join(draft.templateDir, 'app/startup.sh'), 0o755);
    await draft.write('notes.txt');

    const saved = await draft.save();

    expect(saved.hash).toBe(hashSkillTree(readSkillTree(versionDir(draft.agentId, hashOf(saved)))));
  });

  it('removes the Template when template/ is missing or empty', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    await draft.save();

    await rm(draft.templateDir, { recursive: true });
    await mkdir(join(draft.templateDir, 'empty-folder'), { recursive: true });
    const emptied = await draft.save();

    expect(emptied).toEqual({ hash: null, files: [], skipped: [], warnings: [] });
    expect(await draft.developmentTemplate()).toBeNull();
    expect(await versionsOf(draft.agentId)).toEqual([]);

    await rm(draft.templateDir, { recursive: true });
    expect((await draft.save()).hash).toBeNull();
  });

  it('gives the same hash when the same content is saved twice', async () => {
    const draft = await authoring();
    await draft.write('README.md');

    const first = await draft.save();
    const second = await draft.save();

    expect(second.hash).toBe(first.hash);
    expect(await versionsOf(draft.agentId)).toEqual([first.hash]);
  });

  it('keeps file modes', async () => {
    const draft = await authoring();
    await draft.write('scripts/check.sh', '#!/bin/sh\nexit 0\n');
    await chmod(join(draft.templateDir, 'scripts/check.sh'), 0o755);
    await draft.write('scripts/README.md');

    const saved = await draft.save();

    expect(saved.files).toEqual([
      { path: 'scripts/README.md', size: 18, executable: false },
      { path: 'scripts/check.sh', size: 17, executable: true },
    ]);
    const version = versionDir(draft.agentId, hashOf(saved));
    expect((await stat(join(version, 'scripts/check.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(version, 'scripts/README.md'))).mode & 0o111).toBe(0);
  });

  it('refuses symlinks, the platform app files and .env files, listing every one and saving nothing', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const before = await draft.save();

    await draft.write('app/opsiforce.env.json', '{}');
    await draft.write('app/app.meta.json', '{}');
    await draft.write('.env', 'TOKEN=1');
    await draft.write('app/.env.local', 'TOKEN=1');
    await draft.write('app/.env.example', 'TOKEN=');
    await symlink('/etc/hosts', join(draft.templateDir, 'hosts'));

    const refusal = await refusalOf(draft.save());

    expect(refusal.status).toBe(422);
    expect(refusal.body.code).toBe('template_refused');
    expect((refusal.body.refusals as { path: string }[]).map((item) => item.path)).toEqual([
      '.env',
      'app/.env.local',
      'app/app.meta.json',
      'app/opsiforce.env.json',
      'hosts',
    ]);
    expect(await draft.developmentTemplate()).toEqual({ hash: before.hash, damaged: false });
    expect(await versionsOf(draft.agentId)).toEqual([before.hash]);
  });

  it('skips and lists what a Project must not start with, and saves ordinary files beside them', async () => {
    const draft = await authoring();
    const skipped = [
      'AGENTS.md',
      'app/AGENTS.md',
      'opencode.json',
      'opencode.jsonc',
      '.claude/settings.json',
      'app/.agents/skill.md',
      '.opencode/opencode.json',
      '.opsiforce/state.json',
      '.xdg/config',
      '.git/HEAD',
      'app/node_modules/left-pad/index.js',
      'app/.yarn/cache/left-pad.zip',
      'app/.yarn/unplugged/x/index.js',
      'app/.yarn/sdks/typescript.js',
      'app/.yarn/install-state.gz',
      'app/.pnp.cjs',
      'app/data/app.db',
      '.cache/tool/bin',
      '.config/tool.json',
      '.bun/install',
      'user_uploaded_files/brief.pdf',
      'generated_files/out.pdf',
      'app/dist/index.js',
      'app/debug.log',
    ];
    const kept = [
      '.gitignore',
      'CLAUDE.md',
      '.cursor/rules.md',
      'app/.gitignore',
      'app/.env.example',
      'app/opencode.json',
      'app/src/main.ts',
    ];
    for (const path of [...skipped, ...kept]) await draft.write(path);
    await draft.write('.gitignore', 'build/\n');
    await draft.write('app/.gitignore', 'dist\n*.log\n');

    const saved = await draft.save();

    expect(saved.files.map((file) => file.path).toSorted()).toEqual(kept.toSorted());
    const skippedPaths = saved.skipped.map((entry) => entry.path);
    for (const path of skipped) {
      expect(skippedPaths.some((skippedPath) => path === skippedPath || path.startsWith(`${skippedPath}/`))).toBe(true);
    }
    expect(saved.skipped.find((entry) => entry.path === 'app/dist')?.reason).toMatch(/gitignore/);
    expect(existsSync(join(versionDir(draft.agentId, hashOf(saved)), 'AGENTS.md'))).toBe(false);
  });

  it('warns about key-like strings and saves anyway', async () => {
    const draft = await authoring();
    await draft.write('config/deploy.md', `# Deploy\n\ntoken: ghp_${'a'.repeat(36)}\n`);

    const saved = await draft.save();

    expect(saved.hash).not.toBeNull();
    expect(saved.warnings).toEqual([{ path: 'config/deploy.md', reason: 'line 3 looks like a github-token' }]);
  });

  it('answers template_changed and keeps nothing when template/ changes during the copy', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const before = await draft.save();
    await draft.write('notes.md');

    reads.afterRead = async (path) => {
      if (!path.startsWith(draft.templateDir)) return;
      reads.afterRead = null;
      await writeFile(join(draft.templateDir, 'late.md'), 'written mid-save\n');
    };
    const refusal = await refusalOf(draft.save());
    reads.afterRead = null;

    expect(refusal.status).toBe(409);
    expect(refusal.body.code).toBe('template_changed');
    expect(await draft.developmentTemplate()).toEqual({ hash: before.hash, damaged: false });
    expect(await versionsOf(draft.agentId)).toEqual([before.hash]);
  });

  it('reports a link whose version folder is missing as damage', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const saved = await draft.save();

    await rm(versionDir(draft.agentId, hashOf(saved)), { recursive: true });

    expect(await draft.developmentTemplate()).toEqual({ hash: saved.hash, damaged: true });
  });

  it('shows no Template on an Environment that has none', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    await draft.save();

    const detail = await service.findOne(author, draft.agentId);

    const others = detail.profiles.filter((profile) => profile.environmentId !== developmentId);
    expect(others.length).toBeGreaterThan(0);
    for (const profile of others) expect(profile.template).toBeNull();
  });

  it('refuses a caller that is not the Agent’s Builder chat', async () => {
    const draft = await authoring();
    const other = await authoring();

    expect((await refusalOf(service.saveTemplate(author, draft.agentId, other.chatId))).status).toBe(403);
    expect((await refusalOf(service.saveTemplate(author, draft.agentId, null))).status).toBe(403);
  });
});
