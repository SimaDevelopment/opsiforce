import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents } from '../../db/schema';
import { lockAgentTemplate, tryLockAgentTemplate, type DbExecutor } from '../common/locks';
import { fileMode } from '../common/fs';
import { compareSkillPaths, hashSkillTree, scanKeyLike, SkillTreeHasher, type SkillTree } from '../store/gate';
import {
  templateChanged,
  templateCopyMismatch,
  templateDamaged,
  templateRefused,
  templateVersionMissing,
} from './agent-template.errors';
import type {
  EnvironmentTemplate,
  TemplatePathNote,
  TemplateSavedFile,
  TemplateOverlay,
  TemplateSaveResult,
} from './agent-template.types';
import { scanTemplateSource, type TemplateRefusal, type TemplateSourceFile } from './template-source';

export const AGENT_TEMPLATES_ROOT = 'agent-templates';
const VERSIONS = '.versions';
const DAY_MS = 24 * 60 * 60 * 1000;
const GONE_AGENT_GRACE_MS = 60 * 60 * 1000;
const LAY_RETRIES = 3;

interface StagedCopy {
  hash: string;
  files: TemplateSavedFile[];
  warnings: TemplatePathNote[];
}

@Injectable()
export class AgentTemplateStore {
  private readonly logger = new Logger(AgentTemplateStore.name);
  private readonly storageMountPath: string;
  private readonly stagingRetentionMs: number;

  constructor(configService: ConfigService) {
    this.storageMountPath = configService.getOrThrow<string>('storageMountPath');
    this.stagingRetentionMs = configService.getOrThrow<number>('workspaceCleanupRetentionDays') * DAY_MS;
  }

  async save(agentId: string, developmentEnvironmentId: string, sourceDir: string): Promise<TemplateSaveResult> {
    return db.transaction(async (tx) => {
      await lockAgentTemplate(tx, agentId);
      return this.writeUnlocked(agentId, developmentEnvironmentId, sourceDir);
    });
  }

  /** The hash a save of `sourceDir` would give, or null when it would leave no Template. */
  async hashSource(sourceDir: string): Promise<string | null> {
    const scanned = await scanAndHash(sourceDir);
    if (scanned.refused.length > 0) throw templateRefused(scanned.refused);
    return scanned.hash;
  }

  /** The folder holding the version an Environment links to, refusing a link whose version is missing. */
  async linkedVersion(agentId: string, environmentId: string): Promise<{ hash: string; directory: string } | null> {
    const agentDir = this.agentDir(agentId);
    const hash = await readLinkedHash(join(agentDir, environmentId));
    if (!hash) return null;
    const directory = versionDir(agentDir, hash);
    if (!(await isDirectory(directory))) throw templateDamaged();
    return { hash, directory };
  }

  /** The files of a version folder, refusing one that is missing or no longer hashes to `hash`. */
  async readVersionTree(directory: string, hash: string): Promise<SkillTree> {
    let tree: SkillTree;
    try {
      tree = await Promise.all(
        (await listVersionFiles(directory)).map(async (file) => ({
          path: file.path,
          content: await readFile(join(directory, file.path)),
          executable: file.executable,
        }))
      );
    } catch (error) {
      if (VANISHED_SOURCE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw templateDamaged();
      throw error;
    }
    if (hashSkillTree(tree) !== hash) throw templateDamaged();
    return tree;
  }

  /** Save without taking the lock, for an Agent whose row isn't committed yet so nobody else can hold it. */
  async writeUnlocked(
    agentId: string,
    developmentEnvironmentId: string,
    sourceDir: string
  ): Promise<TemplateSaveResult> {
    const source = await scanTemplateSource(sourceDir);
    if (source.refused.length > 0) throw templateRefused(source.refused);

    const agentDir = this.agentDir(agentId);
    if (source.files.length === 0) {
      await this.removeLink(agentDir, developmentEnvironmentId);
      return { hash: null, files: [], skipped: source.skipped, warnings: [] };
    }

    await mkdir(join(agentDir, VERSIONS), { recursive: true });
    const staging = join(agentDir, `.staging-${randomUUID()}`);
    try {
      const copy = await copyHashing(source.files, staging);
      const again = await scanAndHash(sourceDir);
      if (again.refused.length > 0 || again.hash !== copy.hash) throw templateChanged();

      await this.keepVersion(agentDir, staging, copy.hash);
      await this.pointLink(agentDir, developmentEnvironmentId, copy.hash);
      return { hash: copy.hash, files: copy.files, skipped: source.skipped, warnings: copy.warnings };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Lays the version an Environment links to into `targetDir`; no link lays nothing and answers null. */
  async layInto(agentId: string, environmentId: string, targetDir: string): Promise<string | null> {
    const laid = await this.placeVersion(agentId, environmentId, targetDir, moveEntries);
    return laid?.hash ?? null;
  }

  /** Like `layInto`, but overwrites and adds over what `targetDir` already holds, deleting only a path whose file/directory kind the Template changed. */
  async overlayInto(agentId: string, environmentId: string, targetDir: string): Promise<TemplateOverlay | null> {
    return this.placeVersion(agentId, environmentId, targetDir, overlayEntries);
  }

  private async placeVersion(
    agentId: string,
    environmentId: string,
    targetDir: string,
    place: (staging: string, target: string) => Promise<void>
  ): Promise<TemplateOverlay | null> {
    const agentDir = this.agentDir(agentId);
    for (let attempt = 0; attempt <= LAY_RETRIES; attempt++) {
      const hash = await readLinkedHash(join(agentDir, environmentId));
      if (!hash) return null;
      const version = versionDir(agentDir, hash);
      if (!(await isDirectory(version))) throw templateVersionMissing(agentId, environmentId, hash);

      await mkdir(targetDir, { recursive: true });
      const staging = join(targetDir, `.template-staging-${randomUUID()}`);
      try {
        const copy = await copyVersionHashing(version, staging);
        if (copy?.hash === hash) {
          await place(staging, targetDir);
          return { hash, paths: copy.paths };
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    throw templateCopyMismatch(agentId, environmentId, LAY_RETRIES);
  }

  async hashes(agentId: string): Promise<Map<string, EnvironmentTemplate>> {
    const agentDir = this.agentDir(agentId);
    const templates = new Map<string, EnvironmentTemplate>();
    for (const [environmentId, hash] of await readLinks(agentDir)) {
      templates.set(environmentId, { hash, damaged: !(await isDirectory(versionDir(agentDir, hash))) });
    }
    return templates;
  }

  async publishLink(
    tx: DbExecutor,
    agentId: string,
    fromEnvironmentId: string,
    toEnvironmentId: string
  ): Promise<void> {
    await lockAgentTemplate(tx, agentId);
    const agentDir = this.agentDir(agentId);
    const hash = await readLinkedHash(join(agentDir, fromEnvironmentId));
    if (hash === null) {
      await this.removeLink(agentDir, toEnvironmentId);
      return;
    }
    if (!(await isDirectory(versionDir(agentDir, hash)))) throw templateDamaged();
    await this.pointLink(agentDir, toEnvironmentId, hash);
  }

  /** Removes every Template of an Agent whose row is gone, under its lock so a save in flight finishes first. */
  async removeAgent(agentId: string): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await lockAgentTemplate(tx, agentId);
        await rm(this.agentDir(agentId), { recursive: true, force: true });
      });
    } catch (error) {
      this.logger.warn(`Failed to remove the Templates of agent ${agentId}: ${(error as Error).message}`);
    }
  }

  async sweep(): Promise<void> {
    const root = join(this.storageMountPath, AGENT_TEMPLATES_ROOT);
    const agentIds = (await readdir(root, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
    if (agentIds.length === 0) return;

    const live = new Set(
      (await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, agentIds))).map((row) => row.id)
    );
    for (const agentId of agentIds) {
      try {
        if (live.has(agentId)) await this.sweepLiveAgent(agentId);
        else await this.removeGoneAgent(agentId);
      } catch (error) {
        this.logger.warn(`Failed to sweep the Templates of agent ${agentId}: ${(error as Error).message}`);
      }
    }
  }

  private agentDir(agentId: string): string {
    return join(this.storageMountPath, AGENT_TEMPLATES_ROOT, agentId);
  }

  private async keepVersion(agentDir: string, staging: string, hash: string): Promise<void> {
    if (await isDirectory(versionDir(agentDir, hash))) return;
    await rename(staging, versionDir(agentDir, hash));
  }

  private async pointLink(agentDir: string, environmentId: string, hash: string): Promise<void> {
    const link = join(agentDir, environmentId);
    const previous = await readLinkedHash(link);
    if (previous === hash) return;

    const pending = join(agentDir, `.link-${randomUUID()}`);
    await symlink(posix.join(VERSIONS, hash), pending);
    try {
      await rename(pending, link);
    } catch (error) {
      await rm(pending, { force: true });
      throw error;
    }
    if (previous) await this.removeVersionIfUnlinked(agentDir, previous);
  }

  private async removeLink(agentDir: string, environmentId: string): Promise<void> {
    const link = join(agentDir, environmentId);
    const previous = await readLinkedHash(link);
    if (!previous) return;
    await rm(link, { force: true });
    await this.removeVersionIfUnlinked(agentDir, previous);
  }

  private async removeVersionIfUnlinked(agentDir: string, hash: string): Promise<void> {
    try {
      const linked = [...(await readLinks(agentDir)).values()].includes(hash);
      if (!linked) await rm(versionDir(agentDir, hash), { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(`Left unlinked version ${hash} in ${agentDir} for the sweeper: ${(error as Error).message}`);
    }
  }

  private async removeGoneAgent(agentId: string): Promise<void> {
    const agentDir = this.agentDir(agentId);
    if (!(await olderThan(agentDir, GONE_AGENT_GRACE_MS))) return;
    await rm(agentDir, { recursive: true, force: true });
    this.logger.log(`Removed the Templates of deleted agent ${agentId}`);
  }

  private async sweepLiveAgent(agentId: string): Promise<void> {
    const agentDir = this.agentDir(agentId);
    await this.removeStaleStaging(agentDir);
    await db.transaction(async (tx) => {
      if (!(await tryLockAgentTemplate(tx, agentId))) {
        this.logger.log(`Skipped the Templates of agent ${agentId}: a save or publish holds its lock`);
        return;
      }
      const links = await readLinks(agentDir);
      const linked = new Set(links.values());
      for (const [environmentId, hash] of links) {
        if (!(await isDirectory(versionDir(agentDir, hash)))) {
          this.logger.error(
            `Agent ${agentId} links environment ${environmentId} to missing Template version ${hash}; left in place`
          );
        }
      }
      const versions = await readdir(join(agentDir, VERSIONS)).catch(() => []);
      for (const hash of versions) {
        if (!linked.has(hash)) await rm(versionDir(agentDir, hash), { recursive: true, force: true });
      }
    });
  }

  private async removeStaleStaging(agentDir: string): Promise<void> {
    const names = await readdir(agentDir).catch(() => []);
    for (const name of names) {
      if (!name.startsWith('.') || name === VERSIONS) continue;
      const path = join(agentDir, name);
      if (await olderThan(path, this.stagingRetentionMs)) await rm(path, { recursive: true, force: true });
    }
  }
}

async function olderThan(path: string, ageMs: number): Promise<boolean> {
  try {
    return Date.now() - (await lstat(path)).mtimeMs >= ageMs;
  } catch {
    return false;
  }
}

async function copyHashing(files: TemplateSourceFile[], staging: string): Promise<StagedCopy> {
  const hasher = new SkillTreeHasher();
  const saved: TemplateSavedFile[] = [];
  const warnings: TemplatePathNote[] = [];
  for (const file of files) {
    const content = await readSourceFile(file.absolute);
    const staged = { path: file.path, content, executable: file.executable };
    await stageHashing(hasher, staging, staged);
    saved.push({ path: file.path, size: content.length, executable: file.executable });
    warnings.push(...scanKeyLike([staged]));
  }
  return { hash: hasher.digest(), files: saved, warnings };
}

async function copyVersionHashing(version: string, staging: string): Promise<TemplateOverlay | null> {
  const hasher = new SkillTreeHasher();
  const paths: string[] = [];
  try {
    for (const file of await listVersionFiles(version)) {
      paths.push(file.path);
      const content = await readFile(join(version, file.path));
      await stageHashing(hasher, staging, { path: file.path, content, executable: file.executable });
    }
  } catch (error) {
    if (VANISHED_SOURCE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  return { hash: hasher.digest(), paths };
}

async function stageHashing(
  hasher: SkillTreeHasher,
  staging: string,
  file: { path: string; content: Buffer; executable: boolean }
): Promise<void> {
  hasher.add(file);
  const target = join(staging, file.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content);
  await chmod(target, fileMode(file.executable));
}

async function listVersionFiles(root: string, relative = ''): Promise<{ path: string; executable: boolean }[]> {
  const files: { path: string; executable: boolean }[] = [];
  for (const dirent of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? posix.join(relative, dirent.name) : dirent.name;
    if (dirent.isDirectory()) files.push(...(await listVersionFiles(root, path)));
    else if (dirent.isFile()) {
      files.push({ path, executable: ((await lstat(join(root, path))).mode & 0o111) !== 0 });
    }
  }
  return files.toSorted((a, b) => compareSkillPaths(a.path, b.path));
}

async function moveEntries(from: string, into: string): Promise<void> {
  for (const name of await readdir(from)) {
    await rename(join(from, name), join(into, name));
  }
}

async function overlayEntries(from: string, into: string): Promise<void> {
  for (const dirent of await readdir(from, { withFileTypes: true })) {
    const source = join(from, dirent.name);
    const target = join(into, dirent.name);
    const targetIsDirectory = await isDirectory(target);
    if (dirent.isDirectory() && targetIsDirectory) {
      await overlayEntries(source, target);
      continue;
    }
    if (dirent.isDirectory() || targetIsDirectory) await rm(target, { recursive: true, force: true });
    await rename(source, target);
  }
}

async function scanAndHash(sourceDir: string): Promise<{ refused: TemplateRefusal[]; hash: string | null }> {
  const source = await scanTemplateSource(sourceDir);
  if (source.refused.length > 0 || source.files.length === 0) return { refused: source.refused, hash: null };
  const hasher = new SkillTreeHasher();
  for (const file of source.files) {
    hasher.add({ path: file.path, content: await readSourceFile(file.absolute), executable: file.executable });
  }
  return { refused: [], hash: hasher.digest() };
}

const VANISHED_SOURCE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

async function readSourceFile(absolute: string): Promise<Buffer> {
  try {
    return await readFile(absolute);
  } catch (error) {
    if (VANISHED_SOURCE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw templateChanged();
    throw error;
  }
}

function versionDir(agentDir: string, hash: string): string {
  return join(agentDir, VERSIONS, hash);
}

async function readLinks(agentDir: string): Promise<Map<string, string>> {
  let names: string[];
  try {
    names = await readdir(agentDir);
  } catch {
    return new Map();
  }
  const links = new Map<string, string>();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const hash = await readLinkedHash(join(agentDir, name));
    if (hash) links.set(name, hash);
  }
  return links;
}

async function readLinkedHash(link: string): Promise<string | null> {
  try {
    return posix.basename(await readlink(link));
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
