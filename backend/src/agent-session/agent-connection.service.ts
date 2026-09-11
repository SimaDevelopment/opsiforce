import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { projectEnvironments, projects } from '../../db/schema';
import { Deadline } from '../common/deadline';
import { lockEnvironmentSession, type DbExecutor } from '../common/locks';
import { runtimeBaseUrl, runtimeOpenapiUrl } from '../common/runtime-urls';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { ProjectStatus } from '../project/project.types';
import { ProxyService } from '../proxy/proxy.service';
import { ProjectService } from '../project/project.service';
import { AgentSessionGateway } from './agent-session.gateway';
import { EnvironmentNotRunning, isPodFailure, PodResponded, PodTimeout } from './agent-session.errors';
import { isRootSession, PodOpencodeClient } from './pod-opencode.client';
import type { AgentConnection } from './agent-session.types';

export interface ConnectOptions {
  signal?: AbortSignal;
}

interface EnvironmentBinding {
  id: string;
  podIp: string | null;
  sessionId: string | null;
  status: ProjectStatus;
  disabled: boolean;
}

@Injectable()
export class AgentConnectionService {
  private readonly logger = new Logger(AgentConnectionService.name);
  private readonly budgetMs: number;

  constructor(
    private readonly gateway: AgentSessionGateway,
    private readonly pod: PodOpencodeClient,
    private readonly proxy: ProxyService,
    @Inject(forwardRef(() => ProjectService))
    private readonly projectService: ProjectService,
    configService: ConfigService
  ) {
    this.budgetMs = configService.getOrThrow<number>('agentWakeHoldMs');
  }

  async connect(env: ProjectEnvironmentContext, options: ConnectOptions = {}): Promise<AgentConnection> {
    const deadline = Deadline.in(this.budgetMs, options.signal);
    const ready = await this.gateway.wakeForConnection(env, deadline);

    return this.reportingPodFailures(ready.id, async () => {
      const bound = await deadline.run(() => this.bindPrimarySession(ready, deadline), connectionBudgetExhausted);
      const build = await this.readBuild(bound.upstream, deadline);
      const latest = await deadline.run(() => readBinding(db, ready.id), connectionBudgetExhausted);
      assertCurrentBinding(latest, bound.podIp);
      deadline.assertUnspent(connectionBudgetExhausted);

      return {
        environmentId: ready.id,
        baseUrl: runtimeBaseUrl(ready.id),
        openapiUrl: runtimeOpenapiUrl(ready.id),
        sessionId: bound.sessionId,
        build,
      };
    });
  }

  private async bindPrimarySession(
    ready: ProjectEnvironmentContext,
    deadline: Deadline
  ): Promise<{ sessionId: string; upstream: string; podIp: string }> {
    const current = await readBinding(db, ready.id);
    assertCurrentBinding(current, ready.podIp);
    const upstream = this.proxy.resolveUpstreamForProject(current);
    const bound = (sessionId: string) => ({ sessionId, upstream, podIp: current.podIp });

    if (current.sessionId !== null) {
      deadline.assertUnspent(connectionBudgetExhausted);
      const remembered = await this.pod.getSessionIfPresent(upstream, current.sessionId, {
        signal: deadline.signal(),
      });
      if (remembered && isRootSession(remembered)) return bound(remembered.id);
    }

    deadline.assertUnspent(connectionBudgetExhausted);
    const oldest = await this.pod.oldestRootSession(upstream, { signal: deadline.signal() });
    if (oldest) return bound(await this.rebind(ready.id, current.sessionId, oldest.id));

    return bound(await this.createPrimarySession(ready, upstream, deadline));
  }

  private async rebind(environmentId: string, observed: string | null, next: string): Promise<string> {
    const [claimed] = await db
      .update(projectEnvironments)
      .set({ sessionId: next })
      .where(and(eq(projectEnvironments.id, environmentId), matchesBinding(observed)))
      .returning({ sessionId: projectEnvironments.sessionId });

    if (claimed?.sessionId) {
      this.logger.log(`primary session for ${environmentId}: ${observed ?? 'none'} -> ${next}`);
      return claimed.sessionId;
    }

    const winner = await readBinding(db, environmentId);
    return winner?.sessionId ?? next;
  }

  private async createPrimarySession(
    ready: ProjectEnvironmentContext,
    upstream: string,
    deadline: Deadline
  ): Promise<string> {
    return db.transaction(async (tx) => {
      deadline.assertUnspent(connectionBudgetExhausted);
      await lockEnvironmentSession(tx, ready.id, deadline.remainingMs);
      deadline.assertUnspent(connectionBudgetExhausted);

      const current = await readBinding(tx, ready.id);
      assertCurrentBinding(current, ready.podIp);

      if (current.sessionId !== null) {
        const remembered = await this.pod.getSessionIfPresent(upstream, current.sessionId, {
          signal: deadline.signal(),
        });
        if (remembered && isRootSession(remembered)) return remembered.id;
      }

      deadline.assertUnspent(connectionBudgetExhausted);
      const adopted = await this.pod.oldestRootSession(upstream, { signal: deadline.signal() });
      const session = adopted ?? (await this.pod.createSession(upstream, { signal: deadline.signal() }));

      this.logger.log(`primary session for ${ready.id}: ${current.sessionId ?? 'none'} -> ${session.id}`);
      await tx.update(projectEnvironments).set({ sessionId: session.id }).where(eq(projectEnvironments.id, ready.id));
      return session.id;
    });
  }

  private async readBuild(upstream: string, deadline: Deadline): Promise<string | null> {
    deadline.assertUnspent(connectionBudgetExhausted);
    try {
      const health = await this.pod.health(upstream, { signal: deadline.signal() });
      return health.version ?? null;
    } catch (error) {
      if (error instanceof PodResponded && error.status === 503) throw new EnvironmentNotRunning('starting');
      throw error;
    }
  }

  private async reportingPodFailures<T>(environmentId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Error && isPodFailure(error)) void this.reportPodFailure(environmentId, error);
      throw error;
    }
  }

  private async reportPodFailure(environmentId: string, error: Error): Promise<void> {
    const restarted = await this.projectService.handleProxyFailureByEnvId(environmentId).catch(() => false);
    const reason = error.message;
    this.logger.warn(`pod failure reported for ${environmentId} (${reason}); restart=${restarted}`);
  }
}

async function readBinding(executor: DbExecutor, environmentId: string): Promise<EnvironmentBinding | null> {
  const [row] = await executor
    .select({
      id: projectEnvironments.id,
      podIp: projectEnvironments.podIp,
      sessionId: projectEnvironments.sessionId,
      status: projectEnvironments.status,
      disabled: projects.disabled,
    })
    .from(projectEnvironments)
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .where(eq(projectEnvironments.id, environmentId))
    .limit(1);

  return row ?? null;
}

function matchesBinding(observed: string | null): SQL | undefined {
  return observed === null ? isNull(projectEnvironments.sessionId) : eq(projectEnvironments.sessionId, observed);
}

function connectionBudgetExhausted(): PodTimeout {
  return new PodTimeout('The connection budget ran out before the runtime answered');
}

function assertCurrentBinding(
  current: EnvironmentBinding | null,
  podIp: string | null
): asserts current is EnvironmentBinding & { podIp: string } {
  if (!current) throw new EnvironmentNotRunning('not-found');
  if (current.disabled) throw new EnvironmentNotRunning('disabled');
  if (current.status === ProjectStatus.Failed) throw new EnvironmentNotRunning('failed');
  if (current.status !== ProjectStatus.Active || !current.podIp || current.podIp !== podIp) {
    throw new EnvironmentNotRunning('starting');
  }
}
