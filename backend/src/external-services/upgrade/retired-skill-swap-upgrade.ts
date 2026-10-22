import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import {
  agentProfileSkills,
  agentProfiles,
  environments,
  projectEnvironmentSkillsOff,
  skills,
} from '../../../db/schema';
import { SkillDeliveryService } from '../../delivery/skill-delivery.service';
import { SKILLS_REPLACED_BY_SERVICES, type SkillReplacement } from '../../store/skills-replaced-by-services';
import { ServiceSkillVersions } from '../knowledge/service-skill-versions';
import { ServiceRegistry } from '../registry/service-registry';

interface SwappedAgent {
  agentId: string;
  tenantId: string;
}

// TODO: remove in the release after External Services v2 ships: one-time pin swap, a no-op once every deployment has booted it
@Injectable()
export class RetiredSkillSwapUpgrade implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetiredSkillSwapUpgrade.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly versions: ServiceSkillVersions,
    private readonly skillDeliveries: SkillDeliveryService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const laid: SkillReplacement[] = [];
    for (const swap of SKILLS_REPLACED_BY_SERVICES) {
      const service = this.registry.bySlug(swap.serviceSlug);
      if (!service) continue;
      await this.versions.lay(service);
      laid.push(swap);
    }
    await this.swap(laid);
  }

  async swap(swaps: SkillReplacement[]): Promise<SwappedAgent[]> {
    const swapped = new Map<string, SwappedAgent>();
    for (const swap of swaps) {
      for (const agent of await swapPins(swap)) swapped.set(`${agent.agentId}/${agent.tenantId}`, agent);
      await carrySwitchedOff(swap);
    }
    for (const agent of swapped.values()) {
      await this.skillDeliveries.enqueueServiceSkillsForAgent(agent.agentId, agent.tenantId);
    }
    if (swapped.size > 0) {
      this.logger.log(`Swapped retired skills for their Service skills on ${swapped.size} Agent(s)`);
    }
    return [...swapped.values()];
  }
}

async function swapPins(swap: SkillReplacement): Promise<SwappedAgent[]> {
  const [retired] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.name, swap.retired),
        isNull(skills.tenantId),
        isNull(skills.externalServiceId),
        isNotNull(skills.retiredAt)
      )
    )
    .limit(1);
  const [replacement] = await db
    .select({ id: skills.id, latestVersionId: skills.latestVersionId })
    .from(skills)
    .where(and(eq(skills.name, swap.replacement), isNull(skills.tenantId), isNotNull(skills.externalServiceId)))
    .limit(1);
  if (!retired || !replacement?.latestVersionId) return [];
  const replacementVersionId = replacement.latestVersionId;

  return db.transaction(async (tx) => {
    const pins = await tx
      .select({
        profileId: agentProfileSkills.profileId,
        agentId: agentProfiles.agentId,
        tenantId: environments.tenantId,
      })
      .from(agentProfileSkills)
      .innerJoin(agentProfiles, eq(agentProfiles.id, agentProfileSkills.profileId))
      .innerJoin(environments, eq(environments.id, agentProfiles.environmentId))
      .where(eq(agentProfileSkills.skillId, retired.id));
    if (pins.length === 0) return [];

    await tx
      .insert(agentProfileSkills)
      .values(
        pins.map((pin) => ({ profileId: pin.profileId, skillId: replacement.id, skillVersionId: replacementVersionId }))
      )
      .onConflictDoNothing({ target: [agentProfileSkills.profileId, agentProfileSkills.skillId] });
    await tx.delete(agentProfileSkills).where(
      and(
        eq(agentProfileSkills.skillId, retired.id),
        inArray(
          agentProfileSkills.profileId,
          pins.map((pin) => pin.profileId)
        )
      )
    );
    return pins.map((pin) => ({ agentId: pin.agentId, tenantId: pin.tenantId }));
  });
}

async function carrySwitchedOff(swap: SkillReplacement): Promise<void> {
  await db.transaction(async (tx) => {
    const switchedOff = await tx
      .select()
      .from(projectEnvironmentSkillsOff)
      .where(eq(projectEnvironmentSkillsOff.skillName, swap.retired));
    if (switchedOff.length === 0) return;
    await tx
      .insert(projectEnvironmentSkillsOff)
      .values(switchedOff.map((row) => ({ ...row, skillName: swap.replacement })))
      .onConflictDoNothing();
    await tx.delete(projectEnvironmentSkillsOff).where(eq(projectEnvironmentSkillsOff.skillName, swap.retired));
  });
}
