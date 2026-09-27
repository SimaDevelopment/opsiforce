import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfiles, environments } from '../../db/schema';

export type AgentProfileRow = typeof agentProfiles.$inferSelect;

export class NotADevelopmentProfile extends Error {
  constructor(profileId: string) {
    super(`Agent profile ${profileId} is not parked on the Development environment`);
  }
}

export class NoDevelopmentEnvironment extends Error {
  constructor(tenantId: string) {
    super(`Organization ${tenantId} has no default environment`);
  }
}

export async function assertDevelopmentProfile(profile: AgentProfileRow): Promise<void> {
  const [environment] = await db
    .select({ isDefault: environments.isDefault })
    .from(environments)
    .where(eq(environments.id, profile.environmentId))
    .limit(1);
  if (!environment?.isDefault) throw new NotADevelopmentProfile(profile.id);
}

export async function developmentEnvironmentId(tenantId: string): Promise<string> {
  const [development] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, true)))
    .limit(1);
  if (!development) throw new NoDevelopmentEnvironment(tenantId);
  return development.id;
}

export class NoProductionEnvironment extends Error {
  constructor(tenantId: string) {
    super(`Organization ${tenantId} has no Production environment`);
  }
}

export async function productionEnvironmentId(tenantId: string): Promise<string> {
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(eq(environments.tenantId, tenantId), eq(environments.isProtected, true), eq(environments.isDefault, false))
    )
    .limit(1);
  if (!production) throw new NoProductionEnvironment(tenantId);
  return production.id;
}

export async function builtInProfileFor(agentId: string, tenantId: string): Promise<AgentProfileRow> {
  const development = { id: await developmentEnvironmentId(tenantId) };

  await db
    .insert(agentProfiles)
    .values({ id: crypto.randomUUID(), agentId, environmentId: development.id })
    .onConflictDoNothing({ target: [agentProfiles.agentId, agentProfiles.environmentId] });

  const [profile] = await db
    .select()
    .from(agentProfiles)
    .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, development.id)))
    .limit(1);
  return profile;
}
