import { randomUUID } from 'node:crypto';
import type { V1Pod } from '@kubernetes/client-node';
import { fetchAsLocalhost, type PodRequestInit } from '../../src/pod/pod-fetch';
import type { StartTimer } from '../../src/project/agent-status.service';
import type { SignInProviderConnection } from '../../src/sign-in-provider/sign-in-provider.types';
import type { AppAuthRouteTarget } from '../../src/project/app-auth-route';
import type { ProjectAuthOidcConfig } from '../../src/project/project.types';
import type { JsonObject } from './json';

export interface RecordedCall {
  method: string;
  args: JsonObject;
}

class RecordingFake {
  readonly calls: RecordedCall[] = [];

  protected record(method: string, args: JsonObject = {}): void {
    this.calls.push({ method, args });
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

export class FakePodService extends RecordingFake {
  private readonly readiness = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  private readonly pods = new Map<string, V1Pod>();

  assignedPodName(environmentId: string): string {
    return `opsiforce-agent-${environmentId}`;
  }

  podAddress(_environmentId: string, port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  podFetch(environmentId: string, port: number, path: string, init?: PodRequestInit): Promise<Response> {
    return fetchAsLocalhost(new URL(`${this.podAddress(environmentId, port)}${path}`), init);
  }

  isAssignedPodReady(environmentId: string): boolean {
    const pod = this.pods.get(this.assignedPodName(environmentId));
    return !!pod && !pod.metadata?.deletionTimestamp;
  }

  async createAssignedPod(
    environmentId: string,
    directory: string,
    projectId: string,
    options: { serviceWebhookUrl?: string; runtimeProxyUrl?: string; appPublicUrl?: string } = {}
  ): Promise<{ podName: string; created: boolean }> {
    this.record('createAssignedPod', {
      environmentId,
      directory,
      projectId,
      ...(options.serviceWebhookUrl === undefined ? {} : { serviceWebhookUrl: options.serviceWebhookUrl }),
      ...(options.runtimeProxyUrl === undefined ? {} : { runtimeProxyUrl: options.runtimeProxyUrl }),
      ...(options.appPublicUrl === undefined ? {} : { appPublicUrl: options.appPublicUrl }),
    });
    return { podName: this.assignedPodName(environmentId), created: true };
  }

  async deletePod(podName: string): Promise<void> {
    this.record('deletePod', { podName });
    this.pods.delete(podName);
  }

  async deletePodAndWait(podName: string): Promise<void> {
    this.record('deletePodAndWait', { podName });
    this.pods.delete(podName);
  }

  async getPod(podName: string): Promise<V1Pod | null> {
    this.record('getPod', { podName });
    return this.pods.get(podName) ?? null;
  }

  informerSynced = false;

  getCachedPodSnapshot(podName: string): { synced: boolean; pod?: V1Pod } {
    return { synced: this.informerSynced, pod: this.pods.get(podName) };
  }

  isNotFound(): boolean {
    return true;
  }

  isPodReady(): boolean {
    return true;
  }

  async listPods(): Promise<V1Pod[]> {
    this.record('listPods');
    return [];
  }

  podAgeMs(): number {
    return 0;
  }

  inspectFailureReason(): null {
    return null;
  }

  inspectFailureMessage(): null {
    return null;
  }

  waitForReady(podName: string): Promise<void> {
    this.record('waitForReady', { podName });
    return new Promise<void>((resolve, reject) => {
      this.readiness.set(podName, { resolve, reject });
    });
  }

  setPod(podName: string, podIp = '10.244.0.1', controlToken?: string): void {
    this.pods.set(podName, {
      metadata: { name: podName, uid: randomUUID() },
      status: { podIP: podIp },
      ...(controlToken
        ? { spec: { containers: [{ name: 'agent', env: [{ name: 'OPSIFORCE_CONTROL_TOKEN', value: controlToken }] }] } }
        : {}),
    });
  }

  markPodReady(podName: string, podIp = '10.244.0.1', controlToken?: string): void {
    this.setPod(podName, podIp, controlToken);
    this.readiness.get(podName)?.resolve();
    this.readiness.delete(podName);
  }

  failPodStartup(podName: string, error: Error): void {
    this.readiness.get(podName)?.reject(error);
    this.readiness.delete(podName);
  }
}

export class FakePodCacheService extends RecordingFake {
  onAdd(): void {}
  onUpdate(): void {}
  onDelete(): void {}
  get(): V1Pod | undefined {
    return undefined;
  }
  list(): V1Pod[] {
    return [];
  }
  async waitForSync(): Promise<void> {}
}

export class FakeBifrostService extends RecordingFake {
  enabled = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  async createTenantCustomer(tenantId: string): Promise<null> {
    this.record('createTenantCustomer', { tenantId });
    return null;
  }

  async createProjectResources(params: { projectId: string; tenantId: string }): Promise<void> {
    this.record('createProjectResources', params);
  }

  async getEnvironmentPodOptions(environmentId: string): Promise<null> {
    this.record('getEnvironmentPodOptions', { environmentId });
    return null;
  }

  async resetProjectSpend(projectId: string): Promise<void> {
    this.record('resetProjectSpend', { projectId });
  }

  async revokeProjectKeys(projectId: string): Promise<void> {
    this.record('revokeProjectKeys', { projectId });
  }

  async revokeEnvironmentKeys(environmentId: string): Promise<void> {
    this.record('revokeEnvironmentKeys', { environmentId });
  }
}

export class FakeProjectPoolService extends RecordingFake {
  async claimPending(agentId: string): Promise<string | null> {
    this.record('claimPending', { agentId });
    return null;
  }

  async reconcileAgent(agentId: string): Promise<void> {
    this.record('reconcileAgent', { agentId });
  }

  async releaseAgentSlots(agentId: string): Promise<void> {
    this.record('releaseAgentSlots', { agentId });
  }
}

export class FakeScheduleService extends RecordingFake {
  async removeAllForProject(projectId: string): Promise<void> {
    this.record('removeAllForProject', { projectId });
  }

  async removeAllForEnvironment(environmentId: string): Promise<void> {
    this.record('removeAllForEnvironment', { environmentId });
  }
}

export class FakeTimeoutService extends RecordingFake {
  async touch(environmentId: string): Promise<void> {
    this.record('touch', { environmentId });
  }

  async touchApp(environmentId: string): Promise<void> {
    this.record('touchApp', { environmentId });
  }

  async clear(environmentId: string): Promise<void> {
    this.record('clear', { environmentId });
  }

  async isFullyExpired(): Promise<boolean> {
    return false;
  }
}

export type FakeTimer = StartTimer & { elapse: () => Promise<void> };

export function fakeTimer(): FakeTimer {
  const due = new Set<() => Promise<void>>();
  const start: StartTimer = (task) => {
    due.add(task);
    return () => due.delete(task);
  };
  return Object.assign(start, {
    async elapse() {
      const tasks = [...due];
      due.clear();
      await Promise.all(tasks.map((task) => task()));
    },
  });
}

export type FakeAppAuthGate =
  | { mode: 'manual'; config: ProjectAuthOidcConfig; bypassAuthPaths: string[] }
  | { mode: 'provider'; providerId: string; forwardAccessToken: boolean; bypassAuthPaths: string[] }
  | { mode: 'app_users'; bypassAuthPaths: string[] };

export class FakeProjectAuthService extends RecordingFake {
  private readonly unreachable = new Set<string>();
  private readonly gates = new Map<string, FakeAppAuthGate>();
  private readonly unreconcilable = new Set<string>();
  private readonly held = new Map<string, { reached: () => void; released: Promise<void> }>();

  async apply(env: AppAuthRouteTarget, config: ProjectAuthOidcConfig, bypassAuthPaths: string[] = []): Promise<void> {
    this.record('apply', addressesOf(env));
    this.gates.set(env.id, { mode: 'manual', config, bypassAuthPaths });
  }

  async applyProvider(
    env: AppAuthRouteTarget,
    provider: SignInProviderConnection,
    forwardAccessToken = false,
    bypassAuthPaths: string[] = []
  ): Promise<void> {
    if (this.unreachable.has(env.id)) throw new Error(`Kubernetes refused ${env.id}`);
    const hold = this.held.get(env.id);
    if (hold) {
      this.held.delete(env.id);
      hold.reached();
      await hold.released;
    }
    this.record('applyProvider', {
      ...addressesOf(env),
      providerId: provider.id,
      clientSecret: provider.clientSecret,
      requiredClaim: provider.requiredClaim ? { ...provider.requiredClaim } : null,
      groupsClaim: provider.groupsClaim ?? null,
      forwardAccessToken,
      bypassAuthPaths,
    });
    this.gates.set(env.id, { mode: 'provider', providerId: provider.id, forwardAccessToken, bypassAuthPaths });
  }

  async applySignInHost(provider: SignInProviderConnection): Promise<void> {
    this.record('applySignInHost', {
      providerId: provider.id,
      clientSecret: provider.clientSecret,
      requiredClaim: provider.requiredClaim ? { ...provider.requiredClaim } : null,
    });
  }

  async removeSignInHost(providerId: string): Promise<void> {
    this.record('removeSignInHost', { providerId });
  }

  signInCallbackUrl(providerId: string): string {
    return `https://auth.apps.example.test/p/${providerId}/oidc/callback`;
  }

  setGate(environmentId: string, gate: FakeAppAuthGate): void {
    this.gates.set(environmentId, gate);
  }

  async inheritAuth(fromEnvironmentId: string, to: AppAuthRouteTarget): Promise<string | null> {
    this.record('inheritAuth', { fromEnvironmentId, ...addressesOf(to) });
    const source = this.gates.get(fromEnvironmentId);
    if (!source) throw new Error(`Cannot inherit app auth: source middleware for ${fromEnvironmentId} not found`);
    this.gates.set(to.id, source);
    return source.mode === 'provider' ? source.providerId : null;
  }

  holdNextApplyFor(environmentId: string): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.held.set(environmentId, { reached, released });
    return { reached: reachedPromise, release };
  }

  refuseApplyFor(environmentId: string): void {
    this.unreachable.add(environmentId);
  }

  failReconcileFor(environmentId: string): void {
    this.unreconcilable.add(environmentId);
  }

  async reconcileRoute(env: AppAuthRouteTarget): Promise<void> {
    this.record('reconcileRoute', addressesOf(env));
    if (this.unreconcilable.has(env.id)) throw new Error(`route of ${env.id} cannot be read`);
  }

  async applyAppUsers(env: AppAuthRouteTarget, bypassAuthPaths: string[] = []): Promise<void> {
    this.record('applyAppUsers', { ...addressesOf(env), bypassAuthPaths });
    this.gates.set(env.id, { mode: 'app_users', bypassAuthPaths });
  }

  async inheritAppUsers(fromEnvironmentId: string, to: AppAuthRouteTarget): Promise<void> {
    await this.applyAppUsers(to, (await this.getConfig(fromEnvironmentId)).bypassAuthPaths);
  }

  async writeIdentityHeaderStrip(): Promise<void> {
    this.record('writeIdentityHeaderStrip', {});
  }

  async remove(environmentId: string): Promise<void> {
    this.record('remove', { environmentId });
    this.gates.delete(environmentId);
  }

  async gatedRoutingIds(): Promise<string[]> {
    return [...this.gates.keys()];
  }

  async getConfig(environmentId: string): Promise<{ config?: ProjectAuthOidcConfig; bypassAuthPaths: string[] }> {
    const gate = this.gates.get(environmentId);
    const config =
      gate?.mode === 'manual'
        ? gate.config
        : gate?.mode === 'provider'
          ? { forwardAccessToken: gate.forwardAccessToken }
          : undefined;
    return { config, bypassAuthPaths: gate?.bypassAuthPaths ?? [] };
  }

  gateOf(environmentId: string): FakeAppAuthGate | undefined {
    return this.gates.get(environmentId);
  }

  loseGate(environmentId: string): void {
    this.gates.delete(environmentId);
  }
}

function addressesOf(env: AppAuthRouteTarget): JsonObject {
  return { environmentId: env.id, shortId: env.shortId };
}

type ProjectListener = () => void;

export class FakeProjectEventsService extends RecordingFake {
  private readonly listeners = new Map<string, Set<ProjectListener>>();

  async publish(projectId: string): Promise<void> {
    this.record('publish', { projectId });
    for (const listener of this.listeners.get(projectId) ?? []) listener();
  }

  subscribe(projectId: string, listener: ProjectListener): () => void {
    const listeners = this.listeners.get(projectId) ?? new Set<ProjectListener>();
    listeners.add(listener);
    this.listeners.set(projectId, listeners);
    return () => listeners.delete(listener);
  }
}

/** There is no cluster in a domain test: the Job is driven by the test that needs one. */
export class FakeAgentUpdateK8sService extends RecordingFake {
  async run(): Promise<{ logs: string; succeeded: boolean }> {
    throw new Error('No Kubernetes in a domain test: drive the migrate script from the test instead');
  }

  async isJobRunning(updateId: string): Promise<boolean> {
    this.record('isJobRunning', { updateId });
    return false;
  }
}

export class FakeQueue extends RecordingFake {
  readonly acceptedJobs: JsonObject[] = [];
  private readonly retainedJobIds = new Set<string>();

  async add(name: string, data: JsonObject, opts?: JsonObject): Promise<{ id: string }> {
    this.record('add', { name, data, ...(opts ? { opts } : {}) });
    return { id: `fake-job-${this.calls.length}` };
  }

  async addBulk(jobs: JsonObject[]): Promise<{ id: string }[]> {
    this.record('addBulk', { jobs });
    for (const job of jobs) this.accept(job);
    return jobs.map((_, index) => ({ id: `fake-bulk-job-${index}` }));
  }

  private accept(job: JsonObject): void {
    const opts = (job.opts ?? {}) as { jobId?: string; removeOnComplete?: unknown };
    if (opts.jobId !== undefined) {
      if (this.retainedJobIds.has(opts.jobId)) return;
      if (opts.removeOnComplete !== true) this.retainedJobIds.add(opts.jobId);
    }
    this.acceptedJobs.push(job);
  }

  async setGlobalConcurrency(concurrency: number): Promise<void> {
    this.record('setGlobalConcurrency', { concurrency });
  }

  async upsertJobScheduler(name: string): Promise<void> {
    this.record('upsertJobScheduler', { name });
  }
}

export interface QueuedJob {
  id: string;
  name: string;
  data: JsonObject;
  dueAt: number;
}

export interface FakeJob {
  id: string;
  name: string;
  data: JsonObject;
  updateData(data: JsonObject): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export interface CoalescedJob {
  data: JsonObject;
  isActive(): Promise<boolean>;
  isDelayed(): Promise<boolean>;
  updateData(data: JsonObject): Promise<void>;
  promote(): Promise<void>;
}

export type JobProcessor = (job: FakeJob, token: string) => Promise<unknown>;

const MAX_DRAIN_RUNS = 200;

function assertBullMqJobId(jobId: string): void {
  if (`${parseInt(jobId, 10)}` === jobId) throw new Error('Custom Id cannot be integers');
  if (jobId.includes(':') && jobId.split(':').length !== 3) throw new Error('Custom Id cannot contain :');
}

export class FakeCoalescingQueue extends RecordingFake {
  private readonly queued = new Map<string, QueuedJob>();
  private readonly delays = new Map<string, number[]>();
  private readonly beforeCompletions: (() => Promise<void>)[] = [];
  private activeId: string | null = null;
  private nextId = 1;
  private unavailable: Error | null = null;

  beforeNextCompletion(action: () => Promise<void>): void {
    this.beforeCompletions.push(action);
  }

  async getJob(id: string): Promise<CoalescedJob | undefined> {
    const job = this.queued.get(id);
    if (!job) return undefined;
    const isDelayed = () => this.activeId !== id && job.dueAt > Date.now();
    return {
      data: job.data,
      isActive: async () => this.activeId === id,
      isDelayed: async () => isDelayed(),
      updateData: async (data) => {
        job.data = data;
      },
      promote: async () => {
        if (!isDelayed()) throw new Error(`Job ${id} is not in the delayed state. promote`);
        job.dueAt = Date.now();
      },
    };
  }

  failNextAdd(error: Error): void {
    this.unavailable = error;
  }

  async add(name: string, data: JsonObject, opts: { jobId?: string; delay?: number } = {}): Promise<{ id: string }> {
    this.record('add', { name, data, opts: opts as JsonObject });
    const unavailable = this.unavailable;
    this.unavailable = null;
    if (unavailable) throw unavailable;
    if (opts.jobId !== undefined) assertBullMqJobId(opts.jobId);
    const id = opts.jobId ?? `job-${this.nextId++}`;
    if (!this.queued.has(id)) {
      this.queued.set(id, { id, name, data, dueAt: Date.now() + (opts.delay ?? 0) });
      this.delays.set(id, []);
    }
    return { id };
  }

  jobs(): QueuedJob[] {
    return [...this.queued.values()].map((job) => structuredClone(job));
  }

  restore(jobs: readonly QueuedJob[]): void {
    for (const job of jobs) {
      this.queued.set(job.id, { ...job });
      this.delays.set(job.id, []);
    }
  }

  delaysOf(id: string): number[] {
    return this.delays.get(id) ?? [];
  }

  async drain(processor: JobProcessor, until = Date.now()): Promise<void> {
    for (let run = 0; run < MAX_DRAIN_RUNS; run++) {
      const job = [...this.queued.values()]
        .filter((candidate) => candidate.dueAt <= until)
        .toSorted((a, b) => a.dueAt - b.dueAt)[0];
      if (!job) return;
      let delayed = false;
      const handle: FakeJob = {
        id: job.id,
        name: job.name,
        data: job.data,
        updateData: async (data) => {
          job.data = data;
          handle.data = data;
        },
        moveToDelayed: async (timestamp) => {
          delayed = true;
          this.delays.get(job.id)?.push(Math.round((timestamp - Date.now()) / 1000) * 1000);
          job.dueAt = Math.max(timestamp, job.dueAt + 1);
        },
      };
      this.activeId = job.id;
      try {
        await processor(handle, 'fake-token');
        await this.beforeCompletions.shift()?.();
        this.queued.delete(job.id);
      } catch (error) {
        if (delayed && (error as Error).name === 'DelayedError') continue;
        this.queued.delete(job.id);
        throw error;
      } finally {
        this.activeId = null;
      }
    }
    throw new Error(`The queue was still busy after ${MAX_DRAIN_RUNS} runs`);
  }
}
