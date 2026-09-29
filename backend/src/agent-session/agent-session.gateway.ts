import { setTimeout } from 'node:timers/promises';
import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentUpdateService } from '../agent-update/agent-update.service';
import type { Deadline } from '../common/deadline';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { ProjectService, type EnsureEnvironmentResult } from '../project/project.service';
import { ProxyService } from '../proxy/proxy.service';
import { EnvironmentNotRunning } from './agent-session.errors';
import { PodOpencodeClient } from './pod-opencode.client';
import type { ActiveSessionSnapshot, PodEnvironmentRef } from './agent-session.types';

const ACTIVE_PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class AgentSessionGateway {
  private readonly logger = new Logger(AgentSessionGateway.name);
  private readonly wakePollMs: number;

  constructor(
    @Inject(forwardRef(() => ProjectService))
    private readonly projectService: ProjectService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly proxyService: ProxyService,
    @Inject(forwardRef(() => AgentUpdateService))
    private readonly agentUpdateService: AgentUpdateService,
    private readonly pod: PodOpencodeClient,
    configService: ConfigService
  ) {
    this.wakePollMs = configService.getOrThrow<number>('agentWakePollMs');
  }

  async wakeForConnection(env: ProjectEnvironmentContext, deadline: Deadline): Promise<ProjectEnvironmentContext> {
    const started = await this.holdUntilReady(await deadline.run(() => this.ensure(env), starting), env.id, deadline);
    const reloaded = await deadline.run(() => this.applyPendingReloadGate(started), starting);

    return requireReady(await this.holdUntilReady(reloaded, env.id, deadline));
  }

  async ensureAgentSurface(env: ProjectEnvironmentContext): Promise<EnsureEnvironmentResult> {
    return this.applyPendingReloadGate(await this.projectService.ensureEnvironment(env, 'agent'));
  }

  async activeSessions(env: PodEnvironmentRef): Promise<ActiveSessionSnapshot> {
    if (env.podIp === null) throw new EnvironmentNotRunning('starting');
    const upstream = this.proxyService.resolveUpstreamForProject(env);
    const sessionIds = await this.pod.activeSessions(upstream, ACTIVE_PROBE_TIMEOUT_MS);
    return { sessionIds, busy: sessionIds.length > 0 };
  }

  private async holdUntilReady(
    ensured: EnsureEnvironmentResult,
    environmentId: string,
    deadline: Deadline
  ): Promise<EnsureEnvironmentResult> {
    let latest = ensured;
    while (latest.state === 'starting' && !deadline.expired && !deadline.cancelled) {
      await deadline.run(() => setTimeout(Math.min(this.wakePollMs, deadline.remainingMs)), starting);
      latest = await deadline.run(() => this.ensureById(environmentId), starting);
    }
    return latest;
  }

  private async ensure(env: ProjectEnvironmentContext): Promise<EnsureEnvironmentResult> {
    try {
      return await this.projectService.ensureEnvironment(env, 'agent');
    } catch (error) {
      if (error instanceof NotFoundException) throw new EnvironmentNotRunning('not-found');
      throw error;
    }
  }

  private async ensureById(environmentId: string): Promise<EnsureEnvironmentResult> {
    const env = await this.projectEnvironmentService.findByIdOrNull(environmentId);
    if (!env) throw new EnvironmentNotRunning('not-found');
    return this.ensure(env);
  }

  private async applyPendingReloadGate(ensured: EnsureEnvironmentResult): Promise<EnsureEnvironmentResult> {
    const env = ensured.env;
    if (ensured.state !== 'ready' || !env.isDefault) return ensured;

    const reload = await this.agentUpdateService.applyPendingReloadForEnvironment(env.id).catch((error: Error) => {
      this.logger.warn(`Failed to apply pending agent reload for project ${env.projectId}: ${error.message}`);
      return null;
    });
    if (!reload?.podRecreated) return ensured;

    return this.ensureById(env.id);
  }
}

function requireReady(ensured: EnsureEnvironmentResult): ProjectEnvironmentContext {
  if (ensured.state === 'ready' && ensured.env.podIp !== null) return ensured.env;
  if (ensured.state === 'disabled') throw new EnvironmentNotRunning('disabled');
  if (ensured.state === 'failed') throw new EnvironmentNotRunning('failed');
  throw new EnvironmentNotRunning('starting');
}

function starting(): EnvironmentNotRunning {
  return new EnvironmentNotRunning('starting');
}
