import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agentProfiles, environments, projectEnvironmentSkillsOff, skills } from '../../db/schema';
import type { AgentCaller } from '../../src/agent/agent.types';
import type { SkillDeliveryService } from '../../src/delivery/skill-delivery.service';
import { RetiredSkillSwapUpgrade } from '../../src/external-services/upgrade/retired-skill-swap-upgrade';
import type { ServiceSkillVersions } from '../../src/external-services/knowledge/service-skill-versions';
import type { ServiceRegistry } from '../../src/external-services/registry/service-registry';
import { replacementOf, type SkillReplacement } from '../../src/store/skills-replaced-by-services';
import { defaultEnvironmentId, ensureBuiltInServiceSkill, ensureBuiltInSkill } from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

let harness: DomainTestHarness;
let caller: AgentCaller;
let developmentId: string;
let productionId: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  const tenantId = await createTenantRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  caller = { tenantId, userId: await createUserRow(), canManageAgents: true };
  developmentId = await defaultEnvironmentId(tenantId);
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), ne(environments.id, developmentId)))
    .limit(1);
  productionId = production.id;
});

afterAll(async () => {
  await harness.close();
});

interface Swap {
  replacement: SkillReplacement;
  retired: { skillId: string; versionId: string };
  service: { skillId: string; versionId: string };
}

async function retiredSkillWithServiceReplacement(): Promise<Swap> {
  const suffix = randomUUID().slice(0, 8);
  const retired = await ensureBuiltInSkill(`retired-${suffix}`);
  await db.update(skills).set({ retiredAt: new Date() }).where(eq(skills.id, retired.skillId));
  const serviceSlug = `svc-${suffix}`;
  const service = await ensureBuiltInServiceSkill(serviceSlug);
  return {
    replacement: { retired: `retired-${suffix}`, serviceSlug, replacement: `service-${serviceSlug}` },
    retired,
    service,
  };
}

async function agentWithProfiles(): Promise<{ agentId: string; profileIds: string[] }> {
  const agent = await harness.agents.create(caller, { displayName: `Agent ${randomUUID().slice(0, 8)}` });
  await db
    .insert(agentProfiles)
    .values({ id: randomUUID(), agentId: agent.id, environmentId: productionId })
    .onConflictDoNothing({ target: [agentProfiles.agentId, agentProfiles.environmentId] });
  const profiles = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agent.id));
  return { agentId: agent.id, profileIds: profiles.map((profile) => profile.id) };
}

async function pinsOf(profileId: string) {
  return db
    .select({
      skillId: agentProfileSkills.skillId,
      skillVersionId: agentProfileSkills.skillVersionId,
      serviceSettings: agentProfileSkills.serviceSettings,
    })
    .from(agentProfileSkills)
    .where(eq(agentProfileSkills.profileId, profileId));
}

function upgradeWith(deliveries: Pick<SkillDeliveryService, 'enqueueServiceSkillsForAgent'>) {
  return new RetiredSkillSwapUpgrade(
    {} as ServiceRegistry,
    {} as ServiceSkillVersions,
    deliveries as SkillDeliveryService
  );
}

function recordingDeliveries() {
  return { enqueueServiceSkillsForAgent: vi.fn((): Promise<string[]> => Promise.resolve([])) };
}

describe('the one-time swap of retired skills for their Service skills', () => {
  it('replaces whatsapp and incoming-email with their Service skills', () => {
    expect(replacementOf('whatsapp')?.replacement).toBe('service-whatsapp');
    expect(replacementOf('incoming-email')?.replacement).toBe('service-incoming-email');
    expect(replacementOf('platform')).toBeUndefined();
  });

  it('repins every profile of the Agent to the Service skill’s current Version, without service settings', async () => {
    const swap = await retiredSkillWithServiceReplacement();
    const { agentId, profileIds } = await agentWithProfiles();
    expect(profileIds).toHaveLength(2);
    for (const profileId of profileIds) {
      await db
        .insert(agentProfileSkills)
        .values({ profileId, skillId: swap.retired.skillId, skillVersionId: swap.retired.versionId });
    }
    const deliveries = recordingDeliveries();

    const swapped = await upgradeWith(deliveries).swap([swap.replacement]);

    expect(swapped).toEqual([{ agentId, tenantId: caller.tenantId }]);
    for (const profileId of profileIds) {
      const pins = await pinsOf(profileId);
      expect(pins.map((pin) => pin.skillId)).not.toContain(swap.retired.skillId);
      expect(pins.find((pin) => pin.skillId === swap.service.skillId)).toEqual({
        skillId: swap.service.skillId,
        skillVersionId: swap.service.versionId,
        serviceSettings: null,
      });
    }
    expect(deliveries.enqueueServiceSkillsForAgent).toHaveBeenCalledExactlyOnceWith(agentId, caller.tenantId);
  });

  it('only drops the retired pin where the profile already carries the Service skill', async () => {
    const swap = await retiredSkillWithServiceReplacement();
    const { profileIds } = await agentWithProfiles();
    const [profileId] = profileIds;
    const settings = { notifyOn: ['message.received'] };
    await db.insert(agentProfileSkills).values([
      { profileId, skillId: swap.retired.skillId, skillVersionId: swap.retired.versionId },
      {
        profileId,
        skillId: swap.service.skillId,
        skillVersionId: swap.service.versionId,
        serviceSettings: settings,
      },
    ]);

    await upgradeWith(recordingDeliveries()).swap([swap.replacement]);

    expect(await pinsOf(profileId)).toEqual(
      expect.arrayContaining([
        { skillId: swap.service.skillId, skillVersionId: swap.service.versionId, serviceSettings: settings },
      ])
    );
    expect((await pinsOf(profileId)).map((pin) => pin.skillId)).not.toContain(swap.retired.skillId);
  });

  it('does nothing on a second boot', async () => {
    const swap = await retiredSkillWithServiceReplacement();
    const { profileIds } = await agentWithProfiles();
    await db
      .insert(agentProfileSkills)
      .values({ profileId: profileIds[0], skillId: swap.retired.skillId, skillVersionId: swap.retired.versionId });
    await upgradeWith(recordingDeliveries()).swap([swap.replacement]);
    const after = await pinsOf(profileIds[0]);
    const deliveries = recordingDeliveries();

    expect(await upgradeWith(deliveries).swap([swap.replacement])).toEqual([]);

    expect(await pinsOf(profileIds[0])).toEqual(after);
    expect(deliveries.enqueueServiceSkillsForAgent).not.toHaveBeenCalled();
  });

  it('carries a switched-off retired skill over to its Service skill in that environment', async () => {
    const swap = await retiredSkillWithServiceReplacement();
    const { agentId } = await agentWithProfiles();
    const project = await harness.projects.create({ agentId }, caller.tenantId, { createdBy: caller.userId });
    await db
      .insert(projectEnvironmentSkillsOff)
      .values({ projectEnvironmentId: project.id, skillName: swap.replacement.retired });

    await upgradeWith(recordingDeliveries()).swap([swap.replacement]);

    const switchedOff = await db
      .select({ skillName: projectEnvironmentSkillsOff.skillName })
      .from(projectEnvironmentSkillsOff)
      .where(eq(projectEnvironmentSkillsOff.projectEnvironmentId, project.id));
    expect(switchedOff.map((row) => row.skillName)).toEqual([swap.replacement.replacement]);
  });
});
