import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { skills, skillVersionFiles, skillVersions } from '../../db/schema';
import { AgentReconcilerService } from '../../src/agent/agent-reconciler.service';
import { hashSkillTree, validateSkillTree } from '../../src/store/gate';
import { reservedSkillNames, SkillReconcilerService } from '../../src/store/skill-reconciler.service';
import { readComposedSkills } from '../../src/store/skill-tree';

const agentReconciler = { ready: () => Promise.resolve() } as AgentReconcilerService;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-config-'));
});

function newReconciler(): SkillReconcilerService {
  return new SkillReconcilerService(agentReconciler);
}

function writeSkill(directory: string, name: string, body: string, extra: Record<string, string> = {}): void {
  const skillDirectory = join(directory, name);
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, 'SKILL.md'), body);
  for (const [path, content] of Object.entries(extra)) {
    const target = join(skillDirectory, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
}

function manifest(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function versionsOf(name: string) {
  return db
    .select({ id: skillVersions.id, version: skillVersions.version, contentHash: skillVersions.contentHash })
    .from(skillVersions)
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .where(and(eq(skills.name, name), isNull(skills.tenantId)))
    .orderBy(asc(skillVersions.version));
}

async function skillRow(name: string) {
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.name, name), isNull(skills.tenantId)))
    .limit(1);
  return row;
}

describe('the built-in skill reconciler', () => {
  it('mints one version with its files, description and flags', async () => {
    const name = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), name, manifest(name, 'Reads https://api.example.com/v1 daily.'), {
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
    });

    await newReconciler().reconcile(readComposedSkills(root));

    const row = await skillRow(name);
    expect(row).toMatchObject({
      origin: 'built_in',
      tenantId: null,
      description: 'Reads https://api.example.com/v1 daily.',
    });

    const [version] = await versionsOf(name);
    expect(version.version).toBe(1);
    expect(row.latestVersionId).toBe(version.id);

    const [stored] = await db
      .select({ createdVia: skillVersions.createdVia, flags: skillVersions.flags })
      .from(skillVersions)
      .where(eq(skillVersions.id, version.id));
    expect(stored.createdVia).toBe('reconciler');
    expect(stored.flags).toEqual({ has_executables: true });

    const files = await db
      .select({
        path: skillVersionFiles.path,
        content: skillVersionFiles.content,
        size: skillVersionFiles.size,
        isBinary: skillVersionFiles.isBinary,
      })
      .from(skillVersionFiles)
      .where(eq(skillVersionFiles.versionId, version.id));
    expect(files.map((file) => file.path).toSorted()).toEqual(['SKILL.md', 'scripts/run.sh']);

    const script = files.find((file) => file.path === 'scripts/run.sh');
    expect(script?.content.toString('utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(script?.size).toBe(18);
    expect(script?.isBinary).toBe(false);
  });

  it('writes nothing on a second boot with an unchanged image', async () => {
    const name = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), name, manifest(name, 'Unchanged.'));

    await newReconciler().reconcile(readComposedSkills(root));
    await newReconciler().reconcile(readComposedSkills(root));

    expect(await versionsOf(name)).toHaveLength(1);
  });

  it('mints exactly one new version for the skill whose files changed', async () => {
    const changed = `skill-${randomUUID()}`;
    const stable = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), changed, manifest(changed, 'First.'));
    writeSkill(join(root, 'skills'), stable, manifest(stable, 'Stable.'));
    await newReconciler().reconcile(readComposedSkills(root));

    writeSkill(join(root, 'skills'), changed, manifest(changed, 'Second.'));
    await newReconciler().reconcile(readComposedSkills(root));

    const versions = await versionsOf(changed);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(await versionsOf(stable)).toHaveLength(1);

    const row = await skillRow(changed);
    expect(row.latestVersionId).toBe(versions[1].id);
    expect(row.description).toBe('Second.');
  });

  it('leaves a name that left the image in place', async () => {
    const retired = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), retired, manifest(retired, 'Retired.'));
    await newReconciler().reconcile(readComposedSkills(root));

    const empty = mkdtempSync(join(tmpdir(), 'agent-config-'));
    await newReconciler().reconcile(readComposedSkills(empty));

    expect(await skillRow(retired)).toBeDefined();
    expect(await versionsOf(retired)).toHaveLength(1);
  });

  it('converges on one row and one version when two replicas boot at once', async () => {
    const name = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), name, manifest(name, 'Concurrent.'));
    const composed = readComposedSkills(root);

    await Promise.all([newReconciler().reconcile(composed), newReconciler().reconcile(composed)]);

    const rows = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.name, name), isNull(skills.tenantId)));
    expect(rows).toHaveLength(1);
    expect(await versionsOf(name)).toHaveLength(1);
  });

  it('prefers an agent override over the shared skill of the same name', async () => {
    const name = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), name, manifest(name, 'Shared.'));
    writeSkill(join(root, 'agents', 'app-builder', 'skills'), name, manifest(name, 'Override.'));
    writeSkill(join(root, 'private', 'agents', 'private-builder', 'skills'), name, manifest(name, 'Private.'));

    const composed = readComposedSkills(root);

    expect(composed).toHaveLength(1);
    expect(composed[0].description).toBe('Private.');
  });

  it('reserves every image-shipped name', () => {
    const shared = `skill-${randomUUID()}`;
    const override = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), shared, manifest(shared, 'Shared.'));
    writeSkill(join(root, 'agents', 'app-builder', 'skills'), override, manifest(override, 'Override.'));

    const reserved = reservedSkillNames(root);

    expect(reserved.has(shared)).toBe(true);
    expect(reserved.has(override)).toBe(true);
  });

  it('reserves platform by construction, because the image ships it', () => {
    expect(reservedSkillNames().has('platform')).toBe(true);
  });

  it('reads the image tree the backend actually ships with', () => {
    const shipped = readComposedSkills().map((skill) => skill.name);

    expect(shipped).toContain('dates');
    expect(shipped).toContain('ui');
    expect(shipped).toContain('platform');
    expect(shipped.every((name) => name.length > 0)).toBe(true);
  });

  it('marks an executable file from its mode bit', async () => {
    const name = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), name, manifest(name, 'Executable.'), { 'bin/tool': '#!/bin/sh\n' });
    chmodSync(join(root, 'skills', name, 'bin', 'tool'), 0o755);

    await newReconciler().reconcile(readComposedSkills(root));

    const [version] = await versionsOf(name);
    const rows = await db
      .select({ path: skillVersionFiles.path, isExecutable: skillVersionFiles.isExecutable })
      .from(skillVersionFiles)
      .where(eq(skillVersionFiles.versionId, version.id));
    expect(rows.find((row) => row.path === 'bin/tool')?.isExecutable).toBe(true);
  });
});

describe('the composed skill reader', () => {
  it('surfaces a symlink instead of following it, so the gate can refuse it', () => {
    const name = `skill-${randomUUID()}`;
    const outside = join(root, 'outside.md');
    writeFileSync(outside, 'contents the skill does not own\n');
    writeSkill(join(root, 'skills'), name, manifest(name, 'Links out.'));
    symlinkSync(outside, join(root, 'skills', name, 'link.md'));

    const [composed] = readComposedSkills(root);
    const link = composed.tree.find((file) => file.path === 'link.md');

    expect(link?.symlink).toBe(true);
    expect(link?.content.length).toBe(0);
    expect(validateSkillTree(composed.tree, { expectedName: name }).errors.map((finding) => finding.rule)).toContain(
      'symlink_entry'
    );
  });

  it('hashes a tree exactly as the gate does', () => {
    const name = `skill-${randomUUID()}`;
    writeSkill(join(root, 'skills'), name, manifest(name, 'Shared digest.'), { 'scripts/run.sh': '#!/bin/sh\n' });

    const [composed] = readComposedSkills(root);

    expect(composed.contentHash).toBe(hashSkillTree(composed.tree));
  });
});
