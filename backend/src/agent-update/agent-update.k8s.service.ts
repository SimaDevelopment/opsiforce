import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from '../common/k8s-client';
import { resolvePreset, toK8sResources } from '../pod/pod-classes';
import type { AgentUpdateMode } from './agent-update.types';

const JOB_COMPLETION_GRACE_MS = 60_000;

const UPDATE_ID_LABEL = 'opsiforce.io/agent-update-id';

export interface AgentUpdateJobOptions {
  updateId: string;
  projectEnvironmentId: string;
  directory: string;
  /** The agent image package, which is also the ledger and prompt file name. */
  packageName: string;
  targetVersion: string;
  mode: AgentUpdateMode;
}

export interface AgentUpdateRunResult {
  logs: string;
  succeeded: boolean;
}

@Injectable()
export class AgentUpdateK8sService {
  private readonly batchApi: k8s.BatchV1Api;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly logger = new Logger(AgentUpdateK8sService.name);
  private readonly namespace: string;
  private readonly jobTimeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    const kc = loadKubeConfig();
    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = this.configService.getOrThrow<string>('k8sNamespace');
    this.jobTimeoutMs = this.configService.get<number>('agentUpdateJobTimeoutMs', 30 * 60 * 1000);
  }

  async run(options: AgentUpdateJobOptions): Promise<AgentUpdateRunResult> {
    const jobName = this.jobName(options.projectEnvironmentId);
    await this.batchApi.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJob(jobName, options),
    });

    try {
      const succeeded = await this.waitForCompletion(jobName, this.jobTimeoutMs + JOB_COMPLETION_GRACE_MS);
      const logs = await this.readLogs(jobName);
      return { logs, succeeded };
    } finally {
      await this.deleteJob(jobName);
    }
  }

  private buildJob(jobName: string, options: AgentUpdateJobOptions): k8s.V1Job {
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          app: 'opsiforce-agent-update',
          'opsiforce.io/environment-id': options.projectEnvironmentId,
          [UPDATE_ID_LABEL]: options.updateId,
        },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: Math.ceil(this.jobTimeoutMs / 1000),
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: {
            labels: {
              app: 'opsiforce-agent-update',
              'opsiforce.io/environment-id': options.projectEnvironmentId,
              [UPDATE_ID_LABEL]: options.updateId,
            },
          },
          spec: {
            restartPolicy: 'Never',
            ...(this.imagePullSecrets().length > 0 ? { imagePullSecrets: this.imagePullSecrets() } : {}),
            ...(Object.keys(this.nodeSelector()).length > 0 ? { nodeSelector: this.nodeSelector() } : {}),
            ...(this.tolerations().length > 0 ? { tolerations: this.tolerations() } : {}),
            ...(Object.keys(this.affinity()).length > 0 ? { affinity: this.affinity() } : {}),
            containers: [
              {
                name: 'migrate',
                image: this.configService.getOrThrow<string>('agentContainerImage'),
                imagePullPolicy: this.configService.getOrThrow<string>('agentContainerImagePullPolicy'),
                command: ['agent-workspace-migrate', ...migrateArgs(options.mode)],
                env: [
                  { name: 'AGENT_NAME', value: options.packageName },
                  { name: 'TARGET_VERSION', value: options.targetVersion },
                  { name: 'WORKSPACE', value: '/workspace' },
                ],
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/workspace',
                    subPath: options.directory,
                  },
                ],
                resources: toK8sResources(resolvePreset('small')),
              },
            ],
            volumes: [this.workspaceVolume()],
          },
        },
      },
    };
  }

  private workspaceVolume(): k8s.V1Volume {
    const storageType = this.configService.getOrThrow<'cephfs' | 'hostPath'>('storageType');
    if (storageType === 'hostPath') {
      return {
        name: 'workspace',
        hostPath: {
          path: this.configService.getOrThrow<string>('storageMountPath'),
          type: 'DirectoryOrCreate',
        },
      };
    }

    return {
      name: 'workspace',
      persistentVolumeClaim: {
        claimName: this.configService.getOrThrow<string>('cephfsPvcName'),
      },
    };
  }

  private async waitForCompletion(jobName: string, timeoutMs = 300_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = await this.batchApi.readNamespacedJob({ name: jobName, namespace: this.namespace });
      if ((job.status?.succeeded ?? 0) > 0) return true;
      if ((job.status?.failed ?? 0) > 0) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Agent update job ${jobName} did not complete after ${timeoutMs}ms`);
  }

  private async readLogs(jobName: string): Promise<string> {
    const pods = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });
    const podName = pods.items[0]?.metadata?.name;
    if (!podName) return '';
    const logs = await this.coreApi.readNamespacedPodLog({
      name: podName,
      namespace: this.namespace,
      container: 'migrate',
    });
    return typeof logs === 'string' ? logs : String(logs);
  }

  private async deleteJob(jobName: string): Promise<void> {
    await this.batchApi
      .deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        propagationPolicy: 'Background',
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('NotFound')) this.logger.warn(`Failed to delete agent update job ${jobName}: ${message}`);
      });
  }

  async isJobRunning(updateId: string): Promise<boolean> {
    const jobs = await this.batchApi.listNamespacedJob({
      namespace: this.namespace,
      labelSelector: `${UPDATE_ID_LABEL}=${updateId}`,
    });
    return jobs.items.some((job) => (job.status?.active ?? 0) > 0);
  }

  private jobName(projectEnvironmentId: string): string {
    return `opsiforce-agent-update-${projectEnvironmentId.slice(0, 8)}-${Date.now().toString(36)}`;
  }

  private imagePullSecrets(): Array<{ name: string }> {
    return this.configService.get<Array<{ name: string }>>('imagePullSecrets', []);
  }

  private nodeSelector(): Record<string, string> {
    return this.configService.get<Record<string, string>>('agentNodeSelector', {});
  }

  private tolerations(): k8s.V1Toleration[] {
    return this.configService.get<k8s.V1Toleration[]>('agentTolerations', []);
  }

  private affinity(): k8s.V1Affinity {
    return this.configService.get<k8s.V1Affinity>('agentAffinity', {});
  }
}

function migrateArgs(mode: AgentUpdateMode): string[] {
  return mode === 'full' ? ['--reconcile-content', '--migrate'] : ['--reconcile-content'];
}
