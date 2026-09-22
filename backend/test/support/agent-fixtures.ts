import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfiles, agentSettings, agents, environments, skillVersions, skills } from '../../db/schema';

export interface SeededAgent {
  id: string;
  name: string;
  displayName: string;
  description: string;
}

export interface LiveAgentOptions {
  createdAt?: Date;
  visibility?: string;
  archived?: boolean;
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
  const { withProfile = true, visibility = 'public', archived = false, createdAt } = options;
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
    archived,
    poolSize: 0,
    ...(createdAt ? { createdAt } : {}),
  });
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
