import { Injectable, Logger } from '@nestjs/common';
import { SkillRepository } from '../store/skill.repository';
import { packageSkillNames } from '../store/skill-tree';
import { DeliveryRepository, type DeliveryTarget, type PinnedSkill } from './delivery.repository';
import { modelReference, renderAgentFile, type DeliveryPlan, type DeliverySkill } from './delivery.types';
import { runtimeAgentSlug } from './runtime-agent-slug';
import { WorkspaceWriter } from './workspace-writer';

export class DeliveryTargetMissing extends Error {
  constructor(projectEnvironmentId: string) {
    super(`Project environment ${projectEnvironmentId} has no agent to deliver`);
  }
}

/** Writes an Agent's files into a workspace before its pod exists, once (ADR-0058, ADR-0060). */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly repository: DeliveryRepository,
    private readonly skills: SkillRepository,
    private readonly writer: WorkspaceWriter
  ) {}

  /** Duplicate carries `.opencode/` as an ignored runtime entry, so only the bookkeeping is left. */
  async copyLedger(fromProjectEnvironmentId: string, toProjectEnvironmentId: string): Promise<void> {
    const delivered = await this.repository.delivered(fromProjectEnvironmentId);
    await this.repository.recordDeliveries(toProjectEnvironmentId, delivered);
  }

  async runtimeAgentSlugFor(projectEnvironmentId: string): Promise<string> {
    const target = await this.repository.target(projectEnvironmentId);
    if (!target) throw new DeliveryTargetMissing(projectEnvironmentId);
    return runtimeAgentSlug(target);
  }

  async deliverAtCreate(projectEnvironmentId: string): Promise<DeliveryPlan> {
    const plan = await this.planFor(projectEnvironmentId);
    await this.apply(plan);
    return plan;
  }

  /** Publish (App) into an empty target: the files are copied, never re-derived (ADR-0060 §7). */
  async copyToNewEnvironment(fromProjectEnvironmentId: string, toProjectEnvironmentId: string): Promise<void> {
    const [from, to] = await Promise.all([
      this.repository.target(fromProjectEnvironmentId),
      this.repository.target(toProjectEnvironmentId),
    ]);
    if (!from || !to) throw new DeliveryTargetMissing(from ? toProjectEnvironmentId : fromProjectEnvironmentId);

    const delivered = await this.repository.delivered(fromProjectEnvironmentId);
    await this.writer.copyBackendOwnedFiles(from.directory, to.directory, {
      slug: runtimeAgentSlug(from),
      skillNames: delivered.map((skill) => skill.skillName),
    });
    await this.repository.recordDeliveries(toProjectEnvironmentId, delivered);
    this.logger.log(
      `Copied agent ${runtimeAgentSlug(from)} and ${delivered.length} skill(s) from ${fromProjectEnvironmentId} to ${toProjectEnvironmentId}`
    );
  }

  async pinnedSkillsFor(projectEnvironmentId: string): Promise<{ target: DeliveryTarget; pinned: PinnedSkill[] }> {
    const target = await this.repository.target(projectEnvironmentId);
    if (!target) throw new DeliveryTargetMissing(projectEnvironmentId);
    const profile = await this.behaviourProfile(target);
    return { target, pinned: profile ? await this.repository.pinnedSkills(profile.id) : [] };
  }

  async planFor(projectEnvironmentId: string): Promise<DeliveryPlan> {
    const target = await this.repository.target(projectEnvironmentId);
    if (!target) throw new DeliveryTargetMissing(projectEnvironmentId);

    const slug = runtimeAgentSlug(target);
    const profile = await this.behaviourProfile(target);
    if (target.agentOrigin === 'custom' && !profile) throw new DeliveryTargetMissing(projectEnvironmentId);
    const pinned = profile ? this.deliverableSkills(target, await this.repository.pinnedSkills(profile.id)) : [];

    return {
      projectEnvironmentId,
      directory: target.directory,
      runtimeAgentSlug: slug,
      agentFile:
        target.agentOrigin === 'custom' && profile
          ? { slug, model: modelReference(profile.model, profile.variant), promptBody: profile.promptBody ?? '' }
          : null,
      skills: await this.readTrees(pinned),
    };
  }

  private async apply(plan: DeliveryPlan): Promise<void> {
    await this.writer.clearStaging(plan.directory);
    await this.writer.setDefaultAgent(plan.directory, plan.runtimeAgentSlug);
    if (plan.agentFile) {
      await this.writer.writeAgentPrompt(plan.directory, plan.agentFile.slug, renderAgentFile(plan.agentFile));
    }
    for (const skill of plan.skills) {
      await this.writer.installSkill(plan.directory, skill.name, skill.tree);
    }
    await this.repository.recordDeliveries(
      plan.projectEnvironmentId,
      plan.skills.map((skill) => ({
        skillName: skill.name,
        skillVersionId: skill.skillVersionId,
        contentHash: skill.contentHash,
      }))
    );
    await this.writer.clearStaging(plan.directory);
    this.logger.log(
      `Delivered agent ${plan.runtimeAgentSlug} and ${plan.skills.length} skill(s) to ${plan.projectEnvironmentId}`
    );
  }

  /** On a colliding name the snapshot wins for a Custom Agent, the package for a Built-in one (ADR-0060 §9). */
  private deliverableSkills(target: DeliveryTarget, pinned: PinnedSkill[]): PinnedSkill[] {
    if (target.agentOrigin === 'custom') return pinned;
    const shipped = packageSkillNames(target.agentName);
    return pinned.filter((skill) => !shipped.has(skill.name));
  }

  /** A Custom Agent's Default environment (Agent); a Built-in Agent's Development-parked row. */
  private async behaviourProfile(target: DeliveryTarget) {
    if (!target.tenantId) return undefined;
    const environmentId =
      target.agentOrigin === 'custom'
        ? await this.repository.defaultEnvironmentId(target.agentId, target.tenantId)
        : await this.repository.developmentEnvironmentId(target.tenantId);
    if (!environmentId) return undefined;
    return this.repository.profile(target.agentId, environmentId);
  }

  private async readTrees(pinned: PinnedSkill[]): Promise<DeliverySkill[]> {
    return Promise.all(
      pinned.map(async (skill) => ({
        name: skill.name,
        skillVersionId: skill.skillVersionId,
        contentHash: skill.contentHash,
        tree: await this.skills.readTree(skill.skillVersionId),
      }))
    );
  }
}
