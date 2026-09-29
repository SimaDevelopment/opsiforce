import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import {
  agentProfiles,
  agentSettings,
  agents,
  environments,
  projectEnvironments,
  projects,
  skillVersions,
  skills,
  tenantDisabledAgents,
} from '../../db/schema';
import { scanTemplateSource } from '../../src/agent-template/template-source';
import { hashSkillTree } from '../../src/store/gate';

export interface SeededAgent {
  id: string;
  name: string;
  displayName: string;
  description: string;
}

export interface LiveAgentOptions {
  createdAt?: Date;
  visibility?: string;
  disabled?: boolean;
  withProfile?: boolean;
}

export async function defaultEnvironmentId(tenantId: string): Promise<string> {
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, true)))
    .limit(1);
  return row.id;
}

export async function seedLiveAgent(
  tenantId: string,
  userId: string,
  options: LiveAgentOptions = {}
): Promise<SeededAgent> {
  const { withProfile = true, visibility = 'public', disabled = false, createdAt } = options;
  const id = randomUUID();
  const seeded: SeededAgent = {
    id,
    name: `agent-${id.slice(0, 8)}`,
    displayName: `Agent ${id.slice(0, 4)}`,
    description: `seeded agent ${id.slice(0, 4)}`,
  };
  const environmentId = await defaultEnvironmentId(tenantId);

  await db.insert(agents).values({
    ...seeded,
    tenantId,
    origin: 'custom',
    visibility,
    createdBy: userId,
    poolSize: 0,
    ...(createdAt ? { createdAt } : {}),
  });
  if (disabled) await db.insert(tenantDisabledAgents).values({ tenantId, agentId: id });
  await db.insert(agentSettings).values({ agentId: id, defaultEnvironmentId: environmentId, platformApi: false });
  if (withProfile) {
    await db
      .insert(agentProfiles)
      .values({ id: randomUUID(), agentId: id, environmentId, promptBody: '', model: 'openai/gpt-5.6-sol' });
  }
  return seeded;
}

export async function ensureBuiltInAgent(name: string): Promise<string> {
  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.name, name), isNull(agents.tenantId)))
    .limit(1);
  if (existing) return existing.id;

  const id = randomUUID();
  await db.insert(agents).values({ id, name, displayName: name, origin: 'built_in', visibility: 'public' });
  return id;
}

export async function ensureBuiltInSkill(name: string): Promise<{ skillId: string; versionId: string }> {
  const [existing] = await db
    .select({ id: skills.id, latestVersionId: skills.latestVersionId })
    .from(skills)
    .where(and(eq(skills.name, name), isNull(skills.tenantId)))
    .limit(1);
  if (existing?.latestVersionId) return { skillId: existing.id, versionId: existing.latestVersionId };

  const skillId = existing?.id ?? randomUUID();
  if (!existing) {
    await db.insert(skills).values({ id: skillId, name, origin: 'built_in', visibility: 'public' });
  }
  const versionId = randomUUID();
  await db
    .insert(skillVersions)
    .values({ id: versionId, skillId, version: 1, contentHash: `hash-${versionId}`, createdVia: 'reconciler' });
  await db.update(skills).set({ latestVersionId: versionId }).where(eq(skills.id, skillId));
  return { skillId, versionId };
}

export interface WorkspaceProjectOptions {
  agentId: string;
  createdBy: string;
  kind: 'agent_builder_chat' | 'test';
  createdByProjectId?: string;
}

export async function seedWorkspaceProject(tenantId: string, options: WorkspaceProjectOptions): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    tenantId,
    agentId: options.agentId,
    kind: options.kind,
    title: `${options.kind}-${id.slice(0, 8)}`,
    createdBy: options.createdBy,
    createdByProjectId: options.createdByProjectId ?? null,
  });
  await db.insert(projectEnvironments).values({
    id,
    projectId: id,
    environmentId: await defaultEnvironmentId(tenantId),
    isDefault: true,
    directory: `projects/${id}`,
    platformVersion: '0.0.0-test',
    status: 'active',
  });
  return id;
}

export interface SeededBuilderChat {
  chatId: string;
  templateDir: string;
}

export async function seedBuilderChat(
  tenantId: string,
  agentId: string,
  createdBy: string
): Promise<SeededBuilderChat> {
  const chatId = await seedWorkspaceProject(tenantId, { agentId, createdBy, kind: 'agent_builder_chat' });
  await db.update(agents).set({ builderChatId: chatId }).where(eq(agents.id, agentId));
  return { chatId, templateDir: join(process.env.STORAGE_MOUNT_PATH ?? '', 'projects', chatId, 'template') };
}

export function agentTemplatesDir(agentId: string): string {
  return join(process.env.STORAGE_MOUNT_PATH ?? '', 'agent-templates', agentId);
}

export function agentTemplateFolders(): string[] {
  const root = join(process.env.STORAGE_MOUNT_PATH ?? '', 'agent-templates');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .toSorted();
}

/** The hash a Template save of `sourceDir` would give, read through the same filter the save uses. */
export async function templateSourceHash(sourceDir: string): Promise<string | null> {
  const source = await scanTemplateSource(sourceDir);
  if (source.files.length === 0) return null;
  return hashSkillTree(
    await Promise.all(
      source.files.map(async (file) => ({
        path: file.path,
        content: await readFile(file.absolute),
        executable: file.executable,
      }))
    )
  );
}

/** Runs `during` while a newer Version of a Built-in Skill is its latest, then puts the older one back. */
export async function withNewerBuiltInVersion<T>(
  name: string,
  during: (newer: { skillId: string; olderVersionId: string; newerVersionId: string }) => Promise<T>
): Promise<T> {
  const { skillId, versionId: olderVersionId } = await ensureBuiltInSkill(name);
  const versions = await db
    .select({ version: skillVersions.version })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId));
  const newerVersionId = randomUUID();
  await db.insert(skillVersions).values({
    id: newerVersionId,
    skillId,
    version: Math.max(...versions.map((row) => row.version)) + 1,
    contentHash: `hash-${newerVersionId}`,
    createdVia: 'reconciler',
  });
  await db.update(skills).set({ latestVersionId: newerVersionId }).where(eq(skills.id, skillId));
  try {
    return await during({ skillId, olderVersionId, newerVersionId });
  } finally {
    await db.update(skills).set({ latestVersionId: olderVersionId }).where(eq(skills.id, skillId));
  }
}
