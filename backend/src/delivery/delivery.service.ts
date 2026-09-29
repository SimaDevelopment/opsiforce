import { Injectable, Logger } from '@nestjs/common';
import path from 'node:path';
import { AgentTemplateStore } from '../agent-template/agent-template.store';
import { SkillRepository } from '../store/skill.repository';
import { packageSkillNames } from '../store/skill-tree';
import { DeliveryRepository, type DeliveryTarget, type PinnedSkill } from './delivery.repository';
import {
  BUILDER_TEMPLATE_DIR,
  modelReference,
  renderAgentFile,
  type DeliveryAtCreateOptions,
  type DeliveryPlan,
  type DeliverySkill,
  type TemplateLay,
} from './delivery.types';
import { TEST_PROJECT_KIND } from '../project/project.types';
import { WORKSPACE_GITIGNORE } from './platform-ignores';
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
    private readonly writer: WorkspaceWriter,
    private readonly templates: AgentTemplateStore
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

  async deliverAtCreate(projectEnvironmentId: string, options: DeliveryAtCreateOptions = {}): Promise<DeliveryPlan> {
    const plan = await this.planFor(projectEnvironmentId, options);
    await this.apply(plan);
    return plan;
  }

  /** Reset (Test Project): the workspace was wiped, so the ledger starts empty and everything is laid again. */
  async redeliverIntoWipedWorkspace(projectEnvironmentId: string): Promise<DeliveryPlan> {
    await this.repository.forgetDeliveries(projectEnvironmentId);
    return this.deliverAtCreate(projectEnvironmentId);
  }

  /** Update (Test Project): the Template the create laid, overlaid again; answers the paths it wrote. */
  async overlayTemplate(projectEnvironmentId: string): Promise<string[]> {
    const target = await this.repository.target(projectEnvironmentId);
    if (!target) throw new DeliveryTargetMissing(projectEnvironmentId);
    const lay = await this.templateLay(target, await this.behaviourEnvironmentId(target), {});
    if (!lay) return [];
    const root = path.join(this.writer.root(target.directory), lay.intoDirectory);
    const overlay = await this.templates.overlayInto(lay.agentId, lay.environmentId, root);
    const written = (overlay?.paths ?? []).map((file) => path.posix.join(lay.intoDirectory, file));
    if (written.includes(WORKSPACE_GITIGNORE)) await this.writer.keepPlatformIgnores(target.directory);
    return written;
  }

  /** Publish (App) into an empty target: the files are copied, never re-derived (ADR-0060). */
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

  async planFor(projectEnvironmentId: string, options: DeliveryAtCreateOptions = {}): Promise<DeliveryPlan> {
    const target = await this.repository.target(projectEnvironmentId);
    if (!target) throw new DeliveryTargetMissing(projectEnvironmentId);

    const slug = runtimeAgentSlug(target);
    const environmentId = await this.behaviourEnvironmentId(target);
    const profile = environmentId ? await this.repository.profile(target.agentId, environmentId) : undefined;
    if (target.agentOrigin === 'custom' && !profile) throw new DeliveryTargetMissing(projectEnvironmentId);
    const pinned = profile ? this.deliverableSkills(target, await this.repository.pinnedSkills(profile.id)) : [];

    return {
      projectEnvironmentId,
      directory: target.directory,
      runtimeAgentSlug: slug,
      template: await this.templateLay(target, environmentId, options),
      agentFile:
        target.agentOrigin === 'custom' && profile
          ? { slug, model: modelReference(profile.model, profile.variant), promptBody: profile.promptBody ?? '' }
          : null,
      skills: await this.readTrees(pinned),
    };
  }

  private async apply(plan: DeliveryPlan): Promise<void> {
    await this.writer.clearStaging(plan.directory);
    if (plan.template) {
      const { agentId, environmentId, intoDirectory } = plan.template;
      await this.templates.layInto(agentId, environmentId, path.join(this.writer.root(plan.directory), intoDirectory));
    }
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

  /** On a colliding name the snapshot wins for a Custom Agent, the package for a Built-in one (ADR-0060). */
  private deliverableSkills(target: DeliveryTarget, pinned: PinnedSkill[]): PinnedSkill[] {
    if (target.agentOrigin === 'custom') return pinned;
    const shipped = packageSkillNames(target.agentName);
    return pinned.filter((skill) => !shipped.has(skill.name));
  }

  /** A Custom Agent's Template comes from the Environment its behaviour does; a Builder chat's, from Development. */
  private async templateLay(
    target: DeliveryTarget,
    behaviourEnvironmentId: string | undefined,
    options: DeliveryAtCreateOptions
  ): Promise<TemplateLay | null> {
    if (target.agentOrigin === 'custom' && behaviourEnvironmentId) {
      return { agentId: target.agentId, environmentId: behaviourEnvironmentId, intoDirectory: '.' };
    }
    if (!options.builderSubjectAgentId || !target.tenantId) return null;
    const developmentId = await this.repository.developmentEnvironmentId(target.tenantId);
    if (!developmentId) return null;
    return {
      agentId: options.builderSubjectAgentId,
      environmentId: developmentId,
      intoDirectory: BUILDER_TEMPLATE_DIR,
    };
  }

  private async behaviourProfile(target: DeliveryTarget) {
    const environmentId = await this.behaviourEnvironmentId(target);
    return environmentId ? this.repository.profile(target.agentId, environmentId) : undefined;
  }

  /** Development for a Test Project or a Built-in Agent, otherwise the Default environment (Agent). */
  private async behaviourEnvironmentId(target: DeliveryTarget): Promise<string | undefined> {
    if (!target.tenantId) return undefined;
    const readsDevelopment = target.agentOrigin !== 'custom' || target.kind === TEST_PROJECT_KIND;
    return readsDevelopment
      ? this.repository.developmentEnvironmentId(target.tenantId)
      : this.repository.defaultEnvironmentId(target.agentId, target.tenantId);
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
