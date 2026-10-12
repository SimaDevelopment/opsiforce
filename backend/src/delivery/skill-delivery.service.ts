import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { agentUpdateStaleAfterMs, reapStaleRunningAgentUpdates } from '../agent-update/agent-update.reaper';
import { PLATFORM_SKILL_NAME } from '../agent/agent.types';
import { ProjectStatus } from '../project/project.types';
import { SkillRepository } from '../store/skill.repository';
import type { SkillTree } from '../store/gate';
import { DeliveryRepository, type DeliveredSkill } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import {
  SKILL_DELIVERY_DEFER_DELAY_MS,
  SKILL_DELIVERY_QUEUE,
  SKILL_DELIVERY_RETRY_DELAYS_MS,
  type DeliverySkill,
  type SkillDeliveryJobData,
  type SkillDeliveryOutcome,
} from './delivery.types';
import { PodReloadClient, SkillsNotLive } from './pod-reload.client';
import { isDeliveredServiceSkill } from './service-skill-source';
import { SkillDeliveryRepository, type FanOutTarget } from './skill-delivery.repository';
import { SkillSwitchRepository } from './skill-switch.repository';
import { WorkspaceWriter } from './workspace-writer';

/** A suspended or disabled environment has a workspace but no pod to confirm against. */
const CONFIRMABLE_STATUSES = new Set<string>([ProjectStatus.Active, ProjectStatus.Starting]);

interface PlannedSkill {
  name: string;
  skillVersionId: string | null;
  contentHash: string;
  tree: () => Promise<SkillTree>;
}

interface DeliveryPlan {
  desired: Set<string>;
  omitted: string[];
  changed: PlannedSkill[];
  removable: string[];
}

interface ReconciledAgent {
  name: string;
  origin: string;
}

@Injectable()
export class SkillDeliveryService {
  private readonly logger = new Logger(SkillDeliveryService.name);
  private reaped: Promise<void> | null = null;

  constructor(
    @InjectQueue(SKILL_DELIVERY_QUEUE)
    private readonly queue: Queue<SkillDeliveryJobData>,
    private readonly configService: ConfigService,
    private readonly delivery: DeliveryService,
    private readonly deliveries: DeliveryRepository,
    private readonly fanOut: SkillDeliveryRepository,
    private readonly skills: SkillRepository,
    private readonly writer: WorkspaceWriter,
    private readonly reload: PodReloadClient,
    private readonly switches: SkillSwitchRepository
  ) {}

  async enqueueForAgent(agentId: string, tenantId: string): Promise<string[]> {
    const agent = await this.fanOut.agent(agentId);
    if (agent?.origin !== 'built_in') return [];
    return this.enqueueAgentTargets(agent, tenantId);
  }

  async enqueueServiceSkillsForAgent(agentId: string, tenantId: string): Promise<string[]> {
    const agent = await this.fanOut.agent(agentId);
    if (!agent) return [];
    return this.enqueueAgentTargets(agent, tenantId);
  }

  async enqueueEnvironments(projectEnvironmentIds: string[]): Promise<void> {
    const states = new Map(
      (await this.fanOut.statesFor(projectEnvironmentIds)).map((state) => [state.projectEnvironmentId, state])
    );
    for (const projectEnvironmentId of projectEnvironmentIds) {
      await this.fanOut.writeState(projectEnvironmentId, {
        converged: false,
        pendingSkills: [],
        omittedSkills: states.get(projectEnvironmentId)?.omittedSkills ?? [],
        attempt: 0,
        failedAt: null,
        error: null,
      });
      await this.enqueue(projectEnvironmentId, 0, 0);
    }
  }

  async enqueueEnvironmentsHoldingRetiredSkills(): Promise<string[]> {
    const ids = await this.fanOut.environmentsHolding([...(await this.skills.retiredBuiltInNames())]);
    await this.enqueueEnvironments(ids);
    return ids;
  }

  private async enqueueAgentTargets(agent: { id: string; name: string }, tenantId: string): Promise<string[]> {
    const targets = await this.fanOut.fanOutTargets(agent.id, tenantId);
    const ids = targets.map((target) => target.projectEnvironmentId);
    await this.enqueueEnvironments(ids);
    this.logger.log(`Enqueued a skill delivery for ${ids.length} environment(s) of agent ${agent.name}`);
    return ids;
  }

  async enqueue(projectEnvironmentId: string, attempt: number, delay: number): Promise<void> {
    await this.queue.add(
      'deliver',
      { projectEnvironmentId, attempt },
      {
        deduplication: { id: projectEnvironmentId, keepLastIfActive: true },
        delay,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 1000,
      }
    );
  }

  /** The reap resolves rows a killed process left `running`, which would block every writer. */
  async ready(): Promise<void> {
    this.reaped ??= reapStaleRunningAgentUpdates(agentUpdateStaleAfterMs(this.configService));
    await this.reaped;
  }

  async deliver(data: SkillDeliveryJobData): Promise<SkillDeliveryOutcome> {
    await this.ready();
    const outcome = await this.reconcile(data.projectEnvironmentId);
    if (outcome.status === 'deferred') {
      await this.enqueue(data.projectEnvironmentId, data.attempt, SKILL_DELIVERY_DEFER_DELAY_MS);
    }
    return outcome;
  }

  /** Records the failure and re-queues on the 5/15/30/60-minute ladder, bookkeeping untouched. */
  async recordFailure(data: SkillDeliveryJobData, failure: Error | string): Promise<void> {
    const attempt = data.attempt + 1;
    const state = await this.fanOut.state(data.projectEnvironmentId);
    await this.fanOut.writeState(data.projectEnvironmentId, {
      converged: false,
      pendingSkills: await this.pendingSkillsAfter(data.projectEnvironmentId, failure),
      omittedSkills: state?.omittedSkills ?? [],
      attempt,
      failedAt: new Date(),
      error: failure instanceof Error ? failure.message : failure,
    });
    const delay = SKILL_DELIVERY_RETRY_DELAYS_MS[Math.min(attempt - 1, SKILL_DELIVERY_RETRY_DELAYS_MS.length - 1)];
    await this.enqueue(data.projectEnvironmentId, attempt, delay);
  }

  async reconcile(
    projectEnvironmentId: string,
    options: { holdingUpdateId?: string } = {}
  ): Promise<SkillDeliveryOutcome> {
    const target = await this.fanOut.target(projectEnvironmentId);
    if (!target) return { status: 'skipped', reason: 'environment-gone' };

    const agent = await this.fanOut.agentOf(projectEnvironmentId);
    if (!agent) return { status: 'skipped', reason: 'environment-gone' };
    if (target.status === ProjectStatus.Pending || target.status === ProjectStatus.Claiming) {
      return { status: 'skipped', reason: `status-${target.status}` };
    }
    if (await this.fanOut.hasRunningAgentUpdate(projectEnvironmentId, options.holdingUpdateId)) {
      return { status: 'deferred', reason: 'agent-update-running' };
    }

    const plan = await this.plan(target, agent);
    if (plan.omitted.length > 0) {
      this.logger.log(
        `Omitting built-in skill(s) ${plan.omitted.join(', ')} from ${projectEnvironmentId}: the ${agent.name} package owns them`
      );
    }

    await this.writer.clearStaging(target.directory);
    try {
      for (const skill of plan.changed) await this.write(target, skill);
      for (const name of plan.removable) await this.remove(target, name);
    } finally {
      await this.writer.clearStaging(target.directory);
    }

    if (plan.changed.length > 0 || plan.removable.length > 0) {
      await this.confirm(target, plan.desired, plan.removable);
    }

    await this.fanOut.writeState(projectEnvironmentId, {
      converged: true,
      pendingSkills: [],
      omittedSkills: plan.omitted,
      attempt: 0,
      failedAt: null,
      error: null,
    });
    return {
      status: 'converged',
      written: plan.changed.map((skill) => skill.name),
      deleted: plan.removable,
      omitted: plan.omitted,
    };
  }

  private async plan(target: FanOutTarget, agent: ReconciledAgent): Promise<DeliveryPlan> {
    const builtIn = agent.origin === 'built_in';
    const pinned = builtIn ? (await this.delivery.pinnedSkillsFor(target.projectEnvironmentId)).pinned : [];
    const services = await this.delivery.serviceSkillsFor(target.projectEnvironmentId);
    const owned = builtIn ? await this.writer.ownedSkillNames(target.directory, agent.name) : new Set<string>();
    const switchedOff = await this.switches.switchedOffNames(target.projectEnvironmentId);
    const retired = await this.skills.retiredBuiltInNames();
    const wanted: PlannedSkill[] = [
      ...pinned
        .filter((skill) => !owned.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          skillVersionId: skill.skillVersionId,
          contentHash: skill.contentHash,
          tree: () => this.skills.readTree(skill.skillVersionId),
        })),
      ...services
        .filter((skill) => !owned.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          skillVersionId: skill.skillVersionId,
          contentHash: skill.contentHash,
          tree: skill.tree,
        })),
    ].filter((skill) => !switchedOff.has(skill.name));
    const desired = new Set(wanted.map((skill) => skill.name));
    const delivered = new Map(
      (await this.deliveries.delivered(target.projectEnvironmentId)).map((row) => [row.skillName, row])
    );
    const onDisk = new Set(await this.writer.listSkillNames(target.directory));
    const managed = (row: DeliveredSkill) => builtIn || isDeliveredServiceSkill(row) || retired.has(row.skillName);

    return {
      desired,
      omitted: pinned.filter((skill) => owned.has(skill.name)).map((skill) => skill.name),
      changed: wanted.filter(
        (skill) => !onDisk.has(skill.name) || delivered.get(skill.name)?.contentHash !== skill.contentHash
      ),
      removable: [
        ...new Set([
          ...[...delivered.values()]
            .filter((row) => !desired.has(row.skillName) && !owned.has(row.skillName) && managed(row))
            .map((row) => row.skillName),
          ...[...switchedOff].filter((name) => onDisk.has(name) && name !== PLATFORM_SKILL_NAME),
        ]),
      ],
    };
  }

  async layNow(
    projectEnvironmentId: string,
    skill: DeliverySkill,
    options: { recordDelivery: boolean }
  ): Promise<void> {
    const target = await this.fanOut.target(projectEnvironmentId);
    if (!target) return;
    await this.writer.clearStaging(target.directory);
    try {
      await this.writer.installSkill(target.directory, skill.name, skill.tree);
    } finally {
      await this.writer.clearStaging(target.directory);
    }
    if (options.recordDelivery) {
      await this.deliveries.recordDeliveries(projectEnvironmentId, [
        { skillName: skill.name, skillVersionId: skill.skillVersionId, contentHash: skill.contentHash },
      ]);
    }
    try {
      await this.confirm(target, new Set([skill.name]), []);
    } catch (err) {
      await this.recordFailure({ projectEnvironmentId, attempt: 0 }, err instanceof Error ? err : String(err));
    }
  }

  hasRunningAgentUpdate(projectEnvironmentId: string): Promise<boolean> {
    return this.fanOut.hasRunningAgentUpdate(projectEnvironmentId);
  }

  /** What the Store should report as not applied: what this run was going to do and did not. */
  private async pendingSkillsAfter(projectEnvironmentId: string, failure: Error | string): Promise<string[]> {
    if (failure instanceof SkillsNotLive) return [...failure.missing, ...failure.unexpected];
    const target = await this.fanOut.target(projectEnvironmentId);
    const agent = await this.fanOut.agentOf(projectEnvironmentId);
    if (!target || !agent) return [];
    const plan = await this.plan(target, agent).catch(() => null);
    return plan === null ? [] : [...plan.changed.map((skill) => skill.name), ...plan.removable];
  }

  private async write(target: FanOutTarget, skill: PlannedSkill): Promise<void> {
    await this.writer.installSkill(target.directory, skill.name, await skill.tree());
    await this.deliveries.recordDeliveries(target.projectEnvironmentId, [
      { skillName: skill.name, skillVersionId: skill.skillVersionId, contentHash: skill.contentHash },
    ]);
  }

  private async remove(target: FanOutTarget, name: string): Promise<void> {
    await this.writer.removeSkill(target.directory, name);
    await this.fanOut.deleteDelivery(target.projectEnvironmentId, name);
  }

  private async confirm(target: FanOutTarget, desired: Set<string>, removed: string[]): Promise<void> {
    if (!target.podIp || !CONFIRMABLE_STATUSES.has(target.status)) return;
    await this.reload.notify(target.projectEnvironmentId, target.podIp, ['skills']);
    await this.reload.confirmSkills(target.podIp, [...desired], removed);
  }
}
