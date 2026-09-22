import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { agentUpdateStaleAfterMs, reapStaleRunningAgentUpdates } from '../agent-update/agent-update.reaper';
import { ProjectStatus } from '../project/project.types';
import { SkillRepository } from '../store/skill.repository';
import { DeliveryRepository, type PinnedSkill } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import {
  SKILL_DELIVERY_DEFER_DELAY_MS,
  SKILL_DELIVERY_QUEUE,
  SKILL_DELIVERY_RETRY_DELAYS_MS,
  type SkillDeliveryJobData,
  type SkillDeliveryOutcome,
} from './delivery.types';
import { PodReloadClient, SkillsNotLive } from './pod-reload.client';
import { SkillDeliveryRepository, type FanOutTarget } from './skill-delivery.repository';
import { WorkspaceWriter } from './workspace-writer';

/** A suspended or disabled environment has a workspace but no pod to confirm against. */
const CONFIRMABLE_STATUSES = new Set<string>([ProjectStatus.Active, ProjectStatus.Starting]);

interface DeliveryPlan {
  desired: Set<string>;
  omitted: string[];
  changed: PinnedSkill[];
  removable: string[];
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
    private readonly reload: PodReloadClient
  ) {}

  /** Called by every `PUT`/`DELETE` of a Skill on an Agent. */
  async enqueueForAgent(agentId: string, tenantId: string): Promise<string[]> {
    const agent = await this.fanOut.agent(agentId);
    if (agent?.origin !== 'built_in') return [];

    const targets = await this.fanOut.fanOutTargets(agentId, tenantId);
    const states = new Map(
      (await this.fanOut.statesFor(targets.map((target) => target.projectEnvironmentId))).map((state) => [
        state.projectEnvironmentId,
        state,
      ])
    );
    for (const target of targets) {
      await this.fanOut.writeState(target.projectEnvironmentId, {
        converged: false,
        pendingSkills: [],
        omittedSkills: states.get(target.projectEnvironmentId)?.omittedSkills ?? [],
        attempt: 0,
        failedAt: null,
        error: null,
      });
      await this.enqueue(target.projectEnvironmentId, 0, 0);
    }
    this.logger.log(`Enqueued a skill delivery for ${targets.length} environment(s) of agent ${agent.name}`);
    return targets.map((target) => target.projectEnvironmentId);
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
    if (agent?.origin !== 'built_in') return { status: 'skipped', reason: 'custom-agent' };
    if (target.status === ProjectStatus.Pending || target.status === ProjectStatus.Claiming) {
      return { status: 'skipped', reason: `status-${target.status}` };
    }
    if (await this.fanOut.hasRunningAgentUpdate(projectEnvironmentId, options.holdingUpdateId)) {
      return { status: 'deferred', reason: 'agent-update-running' };
    }

    const plan = await this.plan(target, agent.name);
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

  private async plan(target: FanOutTarget, packageName: string): Promise<DeliveryPlan> {
    const { pinned } = await this.delivery.pinnedSkillsFor(target.projectEnvironmentId);
    const owned = await this.writer.ownedSkillNames(target.directory, packageName);
    const wanted = pinned.filter((skill) => !owned.has(skill.name));
    const desired = new Set(wanted.map((skill) => skill.name));
    const delivered = new Map(
      (await this.deliveries.delivered(target.projectEnvironmentId)).map((row) => [row.skillName, row])
    );
    const onDisk = new Set(await this.writer.listSkillNames(target.directory));

    return {
      desired,
      omitted: pinned.filter((skill) => owned.has(skill.name)).map((skill) => skill.name),
      changed: wanted.filter(
        (skill) => !onDisk.has(skill.name) || delivered.get(skill.name)?.contentHash !== skill.contentHash
      ),
      removable: [...delivered.keys()].filter((name) => !desired.has(name) && !owned.has(name)),
    };
  }

  /** What the Store should report as not applied: what this run was going to do and did not. */
  private async pendingSkillsAfter(projectEnvironmentId: string, failure: Error | string): Promise<string[]> {
    if (failure instanceof SkillsNotLive) return [...failure.missing, ...failure.unexpected];
    const target = await this.fanOut.target(projectEnvironmentId);
    const agent = await this.fanOut.agentOf(projectEnvironmentId);
    if (!target || !agent) return [];
    const plan = await this.plan(target, agent.name).catch(() => null);
    return plan === null ? [] : [...plan.changed.map((skill) => skill.name), ...plan.removable];
  }

  private async write(target: FanOutTarget, skill: PinnedSkill): Promise<void> {
    const tree = await this.skills.readTree(skill.skillVersionId);
    await this.writer.installSkill(target.directory, skill.name, tree);
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
