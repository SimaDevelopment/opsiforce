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
import { EnvironmentNotRunning, isPodDown, PodResponded, PodTimeout } from './agent-session.errors';
import { isRootSession, PodOpencodeClient } from './pod-opencode.client';
import type { AgentConnection, SessionInfo } from './agent-session.types';

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
      const build = await this.readBuild(this.proxy.resolveUpstreamForProject(ready), deadline);
      const bound = await deadline.run(() => this.bindPrimarySession(ready, deadline), connectionBudgetExhausted);
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
    const scope = describe(ready);

    if (current.sessionId !== null) {
      deadline.assertUnspent(connectionBudgetExhausted);
      const remembered = await this.pod.getSessionIfPresent(upstream, current.sessionId, {
        signal: deadline.signal(),
      });
      if (remembered && isRootSession(remembered)) {
        this.logger.log(`${scope}: kept remembered session ${remembered.id}`);
        return bound(remembered.id);
      }
      this.logger.warn(
        `${scope}: remembered session ${current.sessionId} ${describeMismatch(remembered)}; resolving again`
      );
    }

    deadline.assertUnspent(connectionBudgetExhausted);
    const oldest = await this.pod.oldestRootSession(upstream, { signal: deadline.signal() });
    if (oldest) return bound(await this.rebind(ready, current.sessionId, oldest.id));

    return bound(await this.createPrimarySession(ready, upstream, deadline));
  }

  private async rebind(ready: ProjectEnvironmentContext, observed: string | null, next: string): Promise<string> {
    const scope = describe(ready);
    const [claimed] = await db
      .update(projectEnvironments)
      .set({ sessionId: next })
      .where(and(eq(projectEnvironments.id, ready.id), matchesBinding(observed)))
      .returning({ sessionId: projectEnvironments.sessionId });

    if (claimed?.sessionId) {
      this.logger.log(`${scope}: adopted oldest root session ${next} (previously ${observed ?? 'none'})`);
      return claimed.sessionId;
    }

    const winner = await readBinding(db, ready.id);
    const sessionId = winner?.sessionId ?? next;
    this.logger.log(`${scope}: lost the rebind race to a concurrent connection; using ${sessionId}`);
    return sessionId;
  }

  private async createPrimarySession(
    ready: ProjectEnvironmentContext,
    upstream: string,
    deadline: Deadline
  ): Promise<string> {
    const scope = describe(ready);
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
        if (remembered && isRootSession(remembered)) {
          this.logger.log(`${scope}: kept session ${remembered.id} bound by a concurrent connection`);
          return remembered.id;
        }
      }

      deadline.assertUnspent(connectionBudgetExhausted);
      const adopted = await this.pod.oldestRootSession(upstream, { signal: deadline.signal() });
      if (adopted) {
        this.logger.log(
          `${scope}: adopted oldest root session ${adopted.id} under lock (previously ${current.sessionId ?? 'none'})`
        );
      }
      const session = adopted ?? (await this.pod.createSession(upstream, { signal: deadline.signal() }));
      if (!adopted) {
        const message = `${scope}: created session ${session.id} because the runtime reported no root session (previously ${current.sessionId ?? 'none'})`;
        if (current.sessionId === null) this.logger.log(message);
        else this.logger.warn(message);
      }

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
      if (error instanceof Error && isPodDown(error)) void this.reportPodFailure(environmentId, error);
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

function describe(env: ProjectEnvironmentContext): string {
  return `primary session for environment ${env.id} (project ${env.projectId})`;
}

function describeMismatch(remembered: SessionInfo | null): string {
  if (!remembered) return 'is gone from the runtime';
  return `is a child of ${remembered.parentID}`;
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
