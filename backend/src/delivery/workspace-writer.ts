import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeTextAtomic } from '../common/fs';
import type { SkillTree } from '../store/gate';
import {
  AGENTS_DIR,
  LEDGER_DIR,
  OPENCODE_CONFIG_FILE,
  SKILLS_DIR,
  STAGING_DIR,
  type LedgerFile,
} from './delivery.types';

type JsonRecord = Record<string, unknown>;

@Injectable()
export class WorkspaceWriter {
  private readonly storageMountPath: string;

  constructor(configService: ConfigService) {
    this.storageMountPath = configService.getOrThrow<string>('storageMountPath');
  }

  root(directory: string): string {
    return path.join(this.storageMountPath, directory);
  }

  async clearStaging(directory: string): Promise<void> {
    await rm(path.join(this.root(directory), STAGING_DIR), { recursive: true, force: true });
  }

  async setDefaultAgent(directory: string, slug: string): Promise<void> {
    const file = path.join(this.root(directory), OPENCODE_CONFIG_FILE);
    const existing = await readJson(file);
    await writeTextAtomic(file, `${JSON.stringify({ ...existing, default_agent: slug }, null, 2)}\n`);
  }

  async writeAgentPrompt(directory: string, slug: string, contents: string): Promise<void> {
    await writeTextAtomic(path.join(this.root(directory), AGENTS_DIR, `${slug}.md`), contents);
  }

  async installSkill(directory: string, name: string, tree: SkillTree): Promise<void> {
    const target = path.join(this.root(directory), SKILLS_DIR, name);
    if (!(await exists(target))) {
      await this.installFresh(directory, name, tree, target);
      return;
    }
    await this.updateInPlace(target, tree);
  }

  async removeSkill(directory: string, name: string): Promise<void> {
    await rm(path.join(this.root(directory), SKILLS_DIR, name), { recursive: true, force: true });
  }

  async listSkillNames(directory: string): Promise<string[]> {
    return listDirectories(path.join(this.root(directory), SKILLS_DIR));
  }

  hasOpencodeDir(directory: string): Promise<boolean> {
    return exists(path.join(this.root(directory), '.opencode'));
  }

  async ownedSkillNames(directory: string, packageName: string): Promise<Set<string>> {
    const ledger = await this.readLedger(directory, packageName);
    return new Set(Array.isArray(ledger?.ownedSkills) ? ledger.ownedSkills : []);
  }

  private async readLedger(directory: string, packageName: string): Promise<LedgerFile | null> {
    const file = path.join(this.root(directory), LEDGER_DIR, `${packageName}.json`);
    const parsed = await readJson(file);
    return parsed === null ? null : (parsed as LedgerFile);
  }

  async copyBackendOwnedFiles(
    fromDirectory: string,
    toDirectory: string,
    what: { slug: string; skillNames: string[] }
  ): Promise<void> {
    const from = this.root(fromDirectory);
    const to = this.root(toDirectory);

    const config = await readJson(path.join(from, OPENCODE_CONFIG_FILE));
    if (typeof config?.default_agent === 'string') await this.setDefaultAgent(toDirectory, config.default_agent);

    const prompt = await readFile(path.join(from, AGENTS_DIR, `${what.slug}.md`), 'utf8').catch(() => null);
    if (prompt !== null) await this.writeAgentPrompt(toDirectory, what.slug, prompt);

    for (const name of what.skillNames) {
      const source = path.join(from, SKILLS_DIR, name);
      if (!(await exists(source))) continue;
      await cp(source, path.join(to, SKILLS_DIR, name), { recursive: true, dereference: true });
    }
  }

  private async installFresh(directory: string, name: string, tree: SkillTree, target: string): Promise<void> {
    const staging = path.join(this.root(directory), STAGING_DIR, crypto.randomUUID());
    try {
      await writeTree(path.join(staging, name), tree);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(staging, name), target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async updateInPlace(target: string, tree: SkillTree): Promise<void> {
    for (const file of tree) {
      await writeTextAtomic(path.join(target, file.path), file.content, file.executable ? 0o755 : 0o644);
    }
    const keep = new Set(tree.map((file) => file.path));
    for (const relative of await listFiles(target)) {
      if (!keep.has(relative)) await rm(path.join(target, relative), { force: true });
    }
  }
}

async function writeTree(root: string, tree: SkillTree): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const file of tree) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeTextAtomic(target, file.content, file.executable ? 0o755 : 0o644);
  }
}

async function readJson(file: string): Promise<JsonRecord | null> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false
  );
}

async function listDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await listFiles(path.join(root, entry.name), relative)));
    else found.push(relative);
  }
  return found;
}
