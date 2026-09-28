import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfileSkills, agentProfiles, environments, skillVersions, skills } from '../../db/schema';
import {
  assertDevelopmentProfile,
  builtInProfileFor,
  developmentEnvironmentId,
  type AgentProfileRow,
} from '../store/agent-profile.repository';
import { visibilityIncoherent } from '../store/store-errors';
import { assertSkillVisibleToUser, type SkillRow } from '../store/skill-visibility';
import { SkillDeliveryService } from '../delivery/skill-delivery.service';
import { templateDamaged } from '../agent-template/agent-template.errors';
import { AgentTemplateStore } from '../agent-template/agent-template.store';
import { compareTemplates } from '../agent-template/agent-template.types';
import { lockAgentTemplate } from '../common/locks';
import { canEditAgent } from './agent-visibility';
import { duplicateSkillName, notPublishable } from './agent-errors';
import { assertModelSelection } from './agent-models';
import { AgentRepository } from './agent.repository';
import {
  PLATFORM_SKILL_NAME,
  type AgentCaller,
  type AgentProfileSkillResponse,
  type AgentRow,
  type PublishAgentDto,
  type PublishAgentResponse,
  type SetAgentSkillDto,
  type UpdateAgentProfileDto,
} from './agent.types';

export function assertAgentCarriesNoPrivateSkill(agent: AgentRow, names: string[]): void {
  if (names.length === 0) return;
  if (agent.origin !== 'built_in' && agent.visibility !== 'public') return;
  throw visibilityIncoherent(`A public agent cannot carry the private skill(s) \`${names.join('`, `')}\``);
}

interface CarriedRow {
  skillId: string;
  name: string;
  skillVersionId: string;
}

@Injectable()
export class AgentProfileService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly skillDeliveries: SkillDeliveryService,
    private readonly templates: AgentTemplateStore
  ) {}

  async targetProfile(agent: AgentRow, tenantId: string): Promise<AgentProfileRow> {
    if (agent.origin === 'built_in') return builtInProfileFor(agent.id, tenantId);

    const environmentId = await developmentEnvironmentId(tenantId);
    const profile = await this.repository.profileAt(agent.id, environmentId);
    if (!profile) throw new NotFoundException(`Agent ${agent.id} has no Development profile`);
    await assertDevelopmentProfile(profile);
    return profile;
  }

  async updateProfile(agent: AgentRow, caller: AgentCaller, dto: UpdateAgentProfileDto): Promise<void> {
    this.assertProfileWritable(agent, caller);
    if (agent.origin === 'built_in') throw notPublishable(`Agent \`${agent.name}\` is owned by the agent image`);

    const variant = dto.variant?.trim() ? dto.variant.trim() : null;
    assertModelSelection(dto.model ?? '', variant);

    const profile = await this.targetProfile(agent, caller.tenantId);
    await assertDevelopmentProfile(profile);
    await db
      .update(agentProfiles)
      .set({ promptBody: dto.promptBody ?? '', model: dto.model, variant, updatedAt: new Date() })
      .where(eq(agentProfiles.id, profile.id));
  }

  async listSkills(agent: AgentRow, caller: AgentCaller): Promise<AgentProfileSkillResponse[]> {
    const profile = await this.targetProfile(agent, caller.tenantId);
    return (await this.repository.skillsOf([profile.id])).get(profile.id) ?? [];
  }

  async setSkill(
    agent: AgentRow,
    caller: AgentCaller,
    skillId: string,
    dto: SetAgentSkillDto
  ): Promise<AgentProfileSkillResponse[]> {
    this.assertProfileWritable(agent, caller);
    const skill = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    if (skill.disabled) {
      throw new ForbiddenException({
        code: 'skill_disabled',
        message: `Skill \`${skill.name}\` is disabled`,
      });
    }
    if (skill.visibility === 'private') assertAgentCarriesNoPrivateSkill(agent, [skill.name]);

    const profile = await this.targetProfile(agent, caller.tenantId);
    const versionId = await this.resolveVersion(skill, dto.versionId);

    const carried = await this.repository.carriedSkillNames(profile.id);
    const clash = carried.get(skill.name);
    if (clash !== undefined && clash !== skill.id) throw duplicateSkillName(skill.name);

    await db
      .insert(agentProfileSkills)
      .values({ profileId: profile.id, skillId: skill.id, skillVersionId: versionId })
      .onConflictDoUpdate({
        target: [agentProfileSkills.profileId, agentProfileSkills.skillId],
        set: { skillVersionId: versionId, addedAt: new Date() },
      });
    await this.skillDeliveries.enqueueForAgent(agent.id, caller.tenantId);

    return this.listSkills(agent, caller);
  }

  async removeSkill(agent: AgentRow, caller: AgentCaller, skillId: string): Promise<AgentProfileSkillResponse[]> {
    this.assertProfileWritable(agent, caller);
    const skill = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    if (skill.name === PLATFORM_SKILL_NAME) {
      throw new ForbiddenException({
        code: 'not_editable',
        message: `Skill \`${PLATFORM_SKILL_NAME}\` cannot be removed from an agent`,
      });
    }

    const profile = await this.targetProfile(agent, caller.tenantId);
    await db
      .delete(agentProfileSkills)
      .where(and(eq(agentProfileSkills.profileId, profile.id), eq(agentProfileSkills.skillId, skill.id)));
    await this.skillDeliveries.enqueueForAgent(agent.id, caller.tenantId);

    return this.listSkills(agent, caller);
  }

  async publish(agent: AgentRow, caller: AgentCaller, dto: PublishAgentDto): Promise<PublishAgentResponse> {
    this.assertProfileWritable(agent, caller);
    if (agent.origin === 'built_in') throw notPublishable(`Agent \`${agent.name}\` is owned by the agent image`);

    const [target] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.id, dto.environmentId ?? ''), eq(environments.tenantId, caller.tenantId)))
      .limit(1);
    if (!target) throw new NotFoundException(`Environment ${dto.environmentId} not found`);

    const source = await this.targetProfile(agent, caller.tenantId);
    if (source.environmentId === target.id) {
      throw notPublishable('The Development profile is already the source of every publish');
    }

    assertAgentCarriesNoPrivateSkill(agent, await this.repository.privateSkillNames(source.id));

    return db.transaction(async (tx) => {
      await lockAgentTemplate(tx, agent.id);
      const templates = await this.templates.hashes(agent.id);
      const sourceTemplate = templates.get(source.environmentId) ?? null;
      if (sourceTemplate?.damaged) throw templateDamaged();

      const [existing] = await tx
        .select()
        .from(agentProfiles)
        .where(and(eq(agentProfiles.agentId, agent.id), eq(agentProfiles.environmentId, target.id)))
        .limit(1);

      const before = existing ? await carriedRows(tx, existing.id) : [];
      const after = await carriedRows(tx, source.id);

      const applied = {
        ...diff(existing, source, before, after),
        template: compareTemplates(sourceTemplate?.hash ?? null, templates.get(target.id)?.hash ?? null),
      };
      if (existing && isNoOp(applied)) return { applied };

      const profileId = existing?.id ?? crypto.randomUUID();
      if (existing) {
        await tx
          .update(agentProfiles)
          .set({
            promptBody: source.promptBody,
            model: source.model,
            variant: source.variant,
            updatedAt: new Date(),
          })
          .where(eq(agentProfiles.id, profileId));
        await tx.delete(agentProfileSkills).where(eq(agentProfileSkills.profileId, profileId));
      } else {
        await tx.insert(agentProfiles).values({
          id: profileId,
          agentId: agent.id,
          environmentId: target.id,
          promptBody: source.promptBody,
          model: source.model,
          variant: source.variant,
        });
      }

      if (after.length > 0) {
        await tx
          .insert(agentProfileSkills)
          .values(after.map((row) => ({ profileId, skillId: row.skillId, skillVersionId: row.skillVersionId })));
      }

      await this.templates.publishLink(tx, agent.id, source.environmentId, target.id);
      return { applied };
    });
  }

  assertProfileWritable(agent: AgentRow, caller: AgentCaller): void {
    if (agent.origin === 'built_in') return;
    if (!canEditAgent(agent, caller.userId)) {
      throw new ForbiddenException({ code: 'not_editable', message: `Agent \`${agent.name}\` cannot be edited` });
    }
  }

  private async resolveVersion(skill: SkillRow, versionId: string | undefined): Promise<string> {
    if (!versionId) {
      if (!skill.latestVersionId) throw new NotFoundException(`Skill ${skill.id} has no published version`);
      return skill.latestVersionId;
    }
    const [row] = await db
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(and(eq(skillVersions.id, versionId), eq(skillVersions.skillId, skill.id)))
      .limit(1);
    if (!row) throw new NotFoundException(`Version ${versionId} is not a version of skill ${skill.id}`);
    return row.id;
  }
}

async function carriedRows(tx: typeof db, profileId: string): Promise<CarriedRow[]> {
  return tx
    .select({
      skillId: agentProfileSkills.skillId,
      name: skills.name,
      skillVersionId: agentProfileSkills.skillVersionId,
    })
    .from(agentProfileSkills)
    .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
    .where(eq(agentProfileSkills.profileId, profileId));
}

function isNoOp(applied: PublishAgentResponse['applied']): boolean {
  const { added, removed, repinned } = applied.skills;
  return (
    applied.prompt === 'same' &&
    applied.model === null &&
    (applied.template === 'same' || applied.template === 'none') &&
    added.length === 0 &&
    removed.length === 0 &&
    repinned.length === 0
  );
}

function diff(
  existing: AgentProfileRow | undefined,
  source: AgentProfileRow,
  before: CarriedRow[],
  after: CarriedRow[]
): Omit<PublishAgentResponse['applied'], 'template'> {
  const wasPinned = new Map(before.map((row) => [row.skillId, row]));
  const nowPinned = new Map(after.map((row) => [row.skillId, row]));

  return {
    prompt: existing?.promptBody === source.promptBody ? 'same' : 'changed',
    model:
      existing?.model === source.model && existing?.variant === source.variant
        ? null
        : { from: existing?.model ?? null, to: source.model },
    skills: {
      added: after.filter((row) => !wasPinned.has(row.skillId)).map((row) => row.name),
      removed: before.filter((row) => !nowPinned.has(row.skillId)).map((row) => row.name),
      repinned: after
        .filter((row) => {
          const was = wasPinned.get(row.skillId);
          return was !== undefined && was.skillVersionId !== row.skillVersionId;
        })
        .map((row) => row.name),
    },
  };
}
