import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from '../common/k8s-client';
import { buildPodSpec, PodTemplateOptions } from './pod.template';
import { PodCacheService } from './pod.cache.service';
import { resolvePreset, toK8sResources, type K8sResourceRequirements } from './pod-classes';

export interface TenantPodOptions {
  bifrostApiKey?: string;
  bifrostBackendApiKey?: string;
  bifrostProxyUrl?: string;
  gatewayApiKey?: string;
  gatewayUrl?: string;
  platformApiKey?: string;
  platformApiUrl?: string;
  runtimeProxyUrl?: string;
  externalServicesUrl?: string;
  agentName?: string;
  opsiforceEnv?: string;
  environmentSlug?: string | null;
  resources?: K8sResourceRequirements;
  controlToken?: string;
}

export type PodFailureReason = 'ImagePullBackOff' | 'CrashLoopBackOff' | 'Unschedulable';

export class PodStartupFailedError extends Error {
  constructor(
    public readonly podName: string,
    public readonly reason: PodFailureReason,
    detail?: string
  ) {
    super(`Pod ${podName} failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'PodStartupFailedError';
  }
}

@Injectable()
export class PodService {
  private readonly coreApi: k8s.CoreV1Api;
  private readonly logger = new Logger(PodService.name);
  private readonly namespace: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly podCache: PodCacheService
  ) {
    const kc = loadKubeConfig();
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = this.configService.getOrThrow<string>('k8sNamespace');
  }

  private baseOptions(podName: string): PodTemplateOptions {
    return {
      podName,
      namespace: this.namespace,
      agentContainerImage: this.configService.getOrThrow<string>('agentContainerImage'),
      agentPort: this.configService.getOrThrow<number>('agentPort'),
      storageType: this.configService.getOrThrow<'cephfs' | 'hostPath'>('storageType'),
      cephfsPvcName: this.configService.getOrThrow<string>('cephfsPvcName'),
      storageMountPath: this.configService.getOrThrow<string>('storageMountPath'),
      appsHostname: this.configService.getOrThrow<string>('appsHostname'),
      controlPort: this.configService.getOrThrow<number>('agentControlPort'),
      imagePullPolicy: this.configService.getOrThrow<string>('agentContainerImagePullPolicy'),
      resources: this.smallResources(),
      nodeSelector: this.configService.get('agentNodeSelector'),
      tolerations: this.configService.get('agentTolerations'),
      affinity: this.configService.get('agentAffinity'),
      imagePullSecrets: this.configService.get('imagePullSecrets'),
      openaiApiKey: this.configService.get('openaiApiKey'),
    };
  }

  private smallResources(): K8sResourceRequirements {
    return toK8sResources(resolvePreset('small'));
  }

  assignedPodName(environmentId: string): string {
    return `opsiforce-agent-${environmentId.slice(0, 8)}`;
  }

  async createAssignedPod(
    environmentId: string,
    directory: string,
    projectId: string,
    tenantOptions?: TenantPodOptions
  ): Promise<{ podName: string; created: boolean }> {
    const podName = this.assignedPodName(environmentId);
    const existing = await this.readPodIfExists(podName);

    if (existing) {
      if (!existing.metadata?.deletionTimestamp) {
        return { podName, created: false };
      }
      await this.waitForPodDeletion(podName);
    }

    const options: PodTemplateOptions = {
      ...this.baseOptions(podName),
      subPath: directory,
      projectId,
      environmentId,
      ...tenantOptions,
    };

    const spec = buildPodSpec(options);
    try {
      await this.coreApi.createNamespacedPod({
        namespace: this.namespace,
        body: spec,
      });
      this.logger.log(`Created assigned pod ${podName} for project ${projectId}`);
    } catch (err) {
      if (this.isConflict(err)) {
        this.logger.debug(`Assigned pod ${podName} already exists (concurrent create)`);
        return { podName, created: false };
      } else {
        throw err;
      }
    }

    return { podName, created: true };
  }

  private async waitForPodDeletion(podName: string, timeoutMs = 90000): Promise<void> {
    const synced = await this.podCache.waitForSyncWithTimeout(5000);
    if (synced && !this.podCache.getPod(podName)) return;
    if (!synced) {
      return this.waitForPodDeletionByPolling(podName, timeoutMs);
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error(`Pod ${podName} was not deleted after ${timeoutMs}ms`));
      }, timeoutMs);

      const offDelete = this.podCache.onDelete((deletedName, _pod) => {
        if (deletedName !== podName) return;
        finish();
      });

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offDelete();
        if (err) reject(err);
        else resolve();
      };

      if (!this.podCache.getPod(podName)) finish();
    });
  }

  async deletePod(podName: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedPod({
        name: podName,
        namespace: this.namespace,
      });
    } catch (err) {
      if (this.isNotFound(err)) return;
      throw err;
    }
  }

  async deletePodIfMatches(podName: string, resourceVersion: string): Promise<boolean> {
    const body: k8s.V1DeleteOptions = {
      preconditions: { resourceVersion },
    };
    try {
      await this.coreApi.deleteNamespacedPod({
        name: podName,
        namespace: this.namespace,
        body,
      });
      return true;
    } catch (err) {
      if (this.isNotFound(err) || this.isConflict(err)) return false;
      throw err;
    }
  }

  async waitForReady(podName: string, timeoutMs = 180 * 1000): Promise<string> {
    const synced = await this.podCache.waitForSyncWithTimeout(5000);
    if (!synced) {
      return this.waitForReadyByPolling(podName, timeoutMs);
    }

    const initial = this.podCache.getPod(podName);
    if (initial) {
      const failure = this.inspectFailureReason(initial);
      if (failure === 'ImagePullBackOff') {
        throw new PodStartupFailedError(podName, failure);
      }
      const podIp = initial.status?.podIP;
      if (!initial.metadata?.deletionTimestamp && this.isPodReady(initial) && podIp) {
        return podIp;
      }
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let awaitingRecreate = !!initial?.metadata?.deletionTimestamp;
      const timer = setTimeout(() => {
        const current = this.podCache.getPod(podName);
        const failure = current ? this.inspectFailureReason(current) : null;
        if (current && failure === 'Unschedulable') {
          finish(undefined, new PodStartupFailedError(podName, failure, this.inspectFailureMessage(current)));
          return;
        }
        finish(undefined, new Error(`Pod ${podName} not ready after ${timeoutMs}ms`));
      }, timeoutMs);

      const inspect = (pod: k8s.V1Pod) => {
        if (pod.metadata?.name !== podName) return;
        if (pod.metadata?.deletionTimestamp) {
          awaitingRecreate = true;
          return;
        }
        const failure = this.inspectFailureReason(pod);
        if (failure === 'ImagePullBackOff') {
          finish(undefined, new PodStartupFailedError(podName, failure));
          return;
        }
        const podIp = pod.status?.podIP;
        if (this.isPodReady(pod) && podIp) {
          finish(podIp);
        }
      };

      const offAdd = this.podCache.onAdd(inspect);
      const offUpdate = this.podCache.onUpdate(inspect);
      const offDelete = this.podCache.onDelete((deletedName) => {
        if (deletedName !== podName) return;
        if (awaitingRecreate) {
          awaitingRecreate = false;
          return;
        }
        finish(undefined, new Error(`Pod ${podName} was deleted before becoming ready`));
      });

      const finish = (podIp?: string, err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offAdd();
        offUpdate();
        offDelete();
        if (err) reject(err);
        else if (podIp) resolve(podIp);
      };

      const current = this.podCache.getPod(podName);
      if (current) inspect(current);
    });
  }

  async listPods(labelSelector?: string): Promise<k8s.V1Pod[]> {
    const synced = await this.podCache.waitForSyncWithTimeout(2000);
    if (synced) {
      const all = this.podCache.listPods();
      if (!labelSelector) return all;
      return all.filter((pod) => matchesLabelSelector(pod, labelSelector));
    }
    const response = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector,
    });
    return response.items;
  }

  async getPod(podName: string): Promise<k8s.V1Pod> {
    const synced = await this.podCache.waitForSyncWithTimeout(2000);
    if (synced) {
      const cached = this.podCache.getPod(podName);
      if (cached) return cached;
    }
    return this.coreApi.readNamespacedPod({
      name: podName,
      namespace: this.namespace,
    });
  }

  getCachedPodSnapshot(podName: string): { synced: boolean; pod?: k8s.V1Pod } {
    return {
      synced: this.podCache.isSynced(),
      pod: this.podCache.getPod(podName),
    };
  }

  isPodReady(pod: k8s.V1Pod): boolean {
    return !!pod.status?.conditions?.find((condition) => condition.type === 'Ready' && condition.status === 'True');
  }

  podAgeMs(pod: k8s.V1Pod, now = Date.now()): number {
    const created = pod.metadata?.creationTimestamp;
    return created ? now - new Date(created).getTime() : 0;
  }

  inspectFailureReason(pod: k8s.V1Pod): PodFailureReason | null {
    const scheduled = pod.status?.conditions?.find((condition) => condition.type === 'PodScheduled');
    if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') return 'Unschedulable';

    const allStatuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
    for (const cs of allStatuses) {
      const reason = cs.state?.waiting?.reason;
      if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') return 'ImagePullBackOff';
      if (reason === 'CrashLoopBackOff') return 'CrashLoopBackOff';
    }
    return null;
  }

  inspectFailureMessage(pod: k8s.V1Pod): string | undefined {
    const scheduled = pod.status?.conditions?.find((condition) => condition.type === 'PodScheduled');
    if (scheduled?.status === 'False' && scheduled.message) return scheduled.message;

    const allStatuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
    for (const cs of allStatuses) {
      const message = cs.state?.waiting?.message;
      if (message) return message;
    }
    return undefined;
  }

  isNotFound(err: unknown): boolean {
    return this.statusCode(err) === 404;
  }

  private isConflict(err: unknown): boolean {
    return this.statusCode(err) === 409;
  }

  private statusCode(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const candidate = err as {
      code?: unknown;
      statusCode?: unknown;
      response?: { statusCode?: unknown };
      body?: { code?: unknown };
    };
    if (typeof candidate.code === 'number') return candidate.code;
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
    if (candidate.response && typeof candidate.response.statusCode === 'number') {
      return candidate.response.statusCode;
    }
    if (candidate.body && typeof candidate.body.code === 'number') return candidate.body.code;
    return undefined;
  }

  private async readPodIfExists(podName: string): Promise<k8s.V1Pod | null> {
    try {
      return await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace });
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  private async waitForPodDeletionByPolling(podName: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pod = await this.readPodIfExists(podName);
      if (!pod) return;
      await sleep(1000);
    }
    throw new Error(`Pod ${podName} was not deleted after ${timeoutMs}ms`);
  }

  private async waitForReadyByPolling(podName: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let seenReady = false;
    let awaitingRecreate = false;
    while (Date.now() < deadline) {
      const pod = await this.readPodIfExists(podName);
      if (pod) {
        const failure = this.inspectFailureReason(pod);
        if (failure === 'ImagePullBackOff') {
          throw new PodStartupFailedError(podName, failure);
        }
        if (pod.metadata?.deletionTimestamp) {
          awaitingRecreate = true;
        } else {
          seenReady = true;
          awaitingRecreate = false;
          const podIp = pod.status?.podIP;
          if (this.isPodReady(pod) && podIp) return podIp;
        }
      } else if (awaitingRecreate) {
        awaitingRecreate = false;
      } else if (seenReady) {
        throw new Error(`Pod ${podName} was deleted before becoming ready`);
      }
      await sleep(2000);
    }
    const pod = await this.readPodIfExists(podName);
    if (pod && this.inspectFailureReason(pod) === 'Unschedulable') {
      throw new PodStartupFailedError(podName, 'Unschedulable', this.inspectFailureMessage(pod));
    }
    throw new Error(`Pod ${podName} not ready after ${timeoutMs}ms`);
  }
}

function matchesLabelSelector(pod: k8s.V1Pod, selector: string): boolean {
  const labels = pod.metadata?.labels ?? {};
  for (const clause of selector.split(',')) {
    const eq = clause.indexOf('=');
    if (eq === -1) continue;
    const key = clause.slice(0, eq).trim();
    const value = clause.slice(eq + 1).trim();
    if (labels[key] !== value) return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
