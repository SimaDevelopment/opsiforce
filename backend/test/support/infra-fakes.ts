import type { V1Pod } from '@kubernetes/client-node';
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
  private readonly readiness = new Map<string, { resolve: (ip: string) => void; reject: (err: Error) => void }>();
  private readonly pods = new Map<string, V1Pod>();

  assignedPodName(environmentId: string): string {
    return `opsiforce-agent-${environmentId}`;
  }

  async createAssignedPod(
    environmentId: string,
    directory: string,
    projectId: string
  ): Promise<{ podName: string; created: boolean }> {
    this.record('createAssignedPod', { environmentId, directory, projectId });
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

  waitForReady(podName: string): Promise<string> {
    this.record('waitForReady', { podName });
    return new Promise<string>((resolve, reject) => {
      this.readiness.set(podName, { resolve, reject });
    });
  }

  setPod(podName: string, podIp = '10.244.0.1', controlToken?: string): void {
    this.pods.set(podName, {
      metadata: { name: podName },
      status: { podIP: podIp },
      ...(controlToken
        ? { spec: { containers: [{ name: 'agent', env: [{ name: 'OPSIFORCE_CONTROL_TOKEN', value: controlToken }] }] } }
        : {}),
    });
  }

  markPodReady(podName: string, podIp = '10.244.0.1', controlToken?: string): void {
    this.setPod(podName, podIp, controlToken);
    this.readiness.get(podName)?.resolve(podIp);
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
}

export class FakeExternalServiceProvisioningService extends RecordingFake {
  async provisionEnvironment(environmentId: string): Promise<void> {
    this.record('provisionEnvironment', { environmentId });
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

export class FakeProjectAuthService extends RecordingFake {
  async apply(environmentId: string): Promise<void> {
    this.record('apply', { environmentId });
  }

  async applyManaged(environmentId: string): Promise<void> {
    this.record('applyManaged', { environmentId });
  }

  async remove(environmentId: string): Promise<void> {
    this.record('remove', { environmentId });
  }

  callbackUrls(): string[] {
    return [];
  }

  getConfig(): null {
    return null;
  }
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
  async add(name: string, data: JsonObject, opts?: JsonObject): Promise<{ id: string }> {
    this.record('add', { name, data, ...(opts ? { opts } : {}) });
    return { id: `fake-job-${this.calls.length}` };
  }

  async addBulk(jobs: JsonObject[]): Promise<{ id: string }[]> {
    this.record('addBulk', { jobs });
    return jobs.map((_, index) => ({ id: `fake-bulk-job-${index}` }));
  }

  async upsertJobScheduler(name: string): Promise<void> {
    this.record('upsertJobScheduler', { name });
  }
}
