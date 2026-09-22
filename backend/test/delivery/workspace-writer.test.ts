import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SkillTree } from '../../src/store/gate';
import { WorkspaceWriter } from '../../src/delivery/workspace-writer';

let root: string;
let writer: WorkspaceWriter;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'workspace-writer-'));
  writer = new WorkspaceWriter({ getOrThrow: () => root } as unknown as ConfigService);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function directory(): string {
  return `projects/${randomUUID()}`;
}

function tree(...files: [string, string][]): SkillTree {
  return files.map(([file, content]) => ({ path: file, content: Buffer.from(content, 'utf8'), executable: false }));
}

function read(dir: string, ...segments: string[]): Promise<string> {
  return readFile(path.join(root, dir, ...segments), 'utf8');
}

describe('opencode.json', () => {
  it('sets default_agent without dropping what the image already wrote', async () => {
    const dir = directory();
    await mkdir(path.join(root, dir, '.opencode'), { recursive: true });
    await writeFile(path.join(root, dir, '.opencode/opencode.json'), JSON.stringify({ model: 'openai/gpt-5.6-sol' }));

    await writer.setDefaultAgent(dir, 'acme-support');

    expect(JSON.parse(await read(dir, '.opencode/opencode.json'))).toEqual({
      model: 'openai/gpt-5.6-sol',
      default_agent: 'acme-support',
    });
  });

  it('creates the file when the pod has never booted', async () => {
    const dir = directory();
    await writer.setDefaultAgent(dir, 'acme-support');
    expect(JSON.parse(await read(dir, '.opencode/opencode.json'))).toEqual({ default_agent: 'acme-support' });
  });
});

describe('installSkill', () => {
  it('assembles a new skill outside the scanned root and leaves no staging behind', async () => {
    const dir = directory();
    await writer.installSkill(dir, 'charts', tree(['SKILL.md', '# charts\n'], ['references/api.md', 'v1\n']));

    expect(await read(dir, '.opencode/skills/charts/SKILL.md')).toBe('# charts\n');
    expect(await read(dir, '.opencode/skills/charts/references/api.md')).toBe('v1\n');
    expect(await readdir(path.join(root, dir, '.opencode/skills'))).toEqual(['charts']);
    expect(await readdir(path.join(root, dir, '.opsiforce/staging'))).toEqual([]);
  });

  it('updates an existing skill in place and drops files the new version lost', async () => {
    const dir = directory();
    await writer.installSkill(dir, 'charts', tree(['SKILL.md', '# v1\n'], ['references/old.md', 'gone\n']));
    await writer.installSkill(dir, 'charts', tree(['SKILL.md', '# v2\n'], ['references/new.md', 'here\n']));

    expect(await read(dir, '.opencode/skills/charts/SKILL.md')).toBe('# v2\n');
    expect(await read(dir, '.opencode/skills/charts/references/new.md')).toBe('here\n');
    expect(await readdir(path.join(root, dir, '.opencode/skills/charts/references'))).toEqual(['new.md']);
  });

  it('removes a skill directory outright', async () => {
    const dir = directory();
    await writer.installSkill(dir, 'charts', tree(['SKILL.md', '# charts\n']));
    await writer.removeSkill(dir, 'charts');
    expect(await writer.listSkillNames(dir)).toEqual([]);
  });
});

describe('copyBackendOwnedFiles', () => {
  it('carries default_agent, the prompt and only the named skills', async () => {
    const from = directory();
    const to = directory();
    await writer.setDefaultAgent(from, 'acme-support');
    await writer.writeAgentPrompt(from, 'acme-support', '---\nmode: primary\n---\n\nBe helpful.\n');
    await writer.installSkill(from, 'billing', tree(['SKILL.md', '# billing\n']));
    await writer.installSkill(from, 'not-delivered', tree(['SKILL.md', '# nope\n']));

    await writer.copyBackendOwnedFiles(from, to, { slug: 'acme-support', skillNames: ['billing'] });

    expect(JSON.parse(await read(to, '.opencode/opencode.json'))).toEqual({ default_agent: 'acme-support' });
    expect(await read(to, '.opencode/agents/acme-support.md')).toContain('Be helpful.');
    expect(await writer.listSkillNames(to)).toEqual(['billing']);
  });
});

describe('the ledger', () => {
  it('reports the built-in names this workspace actually has installed', async () => {
    const dir = directory();
    await mkdir(path.join(root, dir, '.opsiforce/agents'), { recursive: true });
    await writeFile(
      path.join(root, dir, '.opsiforce/agents/app-builder.json'),
      JSON.stringify({ agentVersion: '1.4.0', ownedSkills: ['platform', 'charts'] })
    );

    expect([...(await writer.ownedSkillNames(dir, 'app-builder'))]).toEqual(['platform', 'charts']);
  });

  it('owns nothing when the workspace has no ledger yet', async () => {
    expect([...(await writer.ownedSkillNames(directory(), 'app-builder'))]).toEqual([]);
  });
});

describe('a re-pin of an installed skill', () => {
  it('never leaves SKILL.md absent', async () => {
    const dir = directory();
    const big = (marker: string): SkillTree =>
      tree(
        ['SKILL.md', `# ${marker}\n`],
        ...Array.from({ length: 200 }, (_, index): [string, string] => [
          `references/file-${index}.md`,
          `${marker} ${'x'.repeat(2048)}\n`,
        ])
      );
    await writer.installSkill(dir, 'charts', big('v1'));

    const seen = { absences: 0, polls: 0, writing: true };
    const poll = (async () => {
      while (seen.writing) {
        seen.polls += 1;
        const manifest = await readFile(path.join(root, dir, '.opencode/skills/charts/SKILL.md'), 'utf8').catch(
          () => null
        );
        if (manifest === null) seen.absences += 1;
      }
    })();

    await writer.installSkill(dir, 'charts', big('v2'));
    seen.writing = false;
    await poll;

    expect(seen.absences).toBe(0);
    expect(seen.polls).toBeGreaterThan(1);
    expect(await read(dir, '.opencode/skills/charts/SKILL.md')).toBe('# v2\n');
  });
});
