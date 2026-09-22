import * as k8s from '@kubernetes/client-node';
import { agentAppPort } from '../agent/agent-config';
import { appPublicUrl } from '../common/app-host';
import type { K8sResourceRequirements } from './pod-classes';

export interface PodTemplateOptions {
  podName: string;
  namespace: string;
  agentContainerImage: string;
  agentPort: number;
  storageType: 'cephfs' | 'hostPath';
  cephfsPvcName: string;
  storageMountPath: string;
  subPath?: string;
  projectId?: string;
  environmentId?: string;
  environmentSlug?: string | null;
  opsiforceEnv?: string;
  appsHostname?: string;
  imagePullPolicy: string;
  resources: K8sResourceRequirements;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<Record<string, string>>;
  affinity?: Record<string, unknown>;
  imagePullSecrets?: Array<{ name: string }>;
  openaiApiKey?: string;
  agentName?: string;
  bifrostProxyUrl?: string;
  bifrostApiKey?: string;
  bifrostBackendApiKey?: string;
  gatewayApiKey?: string;
  gatewayUrl?: string;
  platformApiKey?: string;
  platformApiUrl?: string;
  runtimeProxyUrl?: string;
  externalServicesUrl?: string;
  controlToken?: string;
  controlPort?: number;
}

export function buildPodSpec(options: PodTemplateOptions): k8s.V1Pod {
  const resolvedAgentName = options.agentName || 'app-builder';
  const appPort = agentAppPort(resolvedAgentName);
  const routingId = options.environmentId ?? options.projectId;

  const volumeMounts: k8s.V1VolumeMount[] = [
    {
      name: 'workspace',
      mountPath: '/workspace',
      ...(options.subPath ? { subPath: options.subPath } : {}),
    },
  ];

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: options.podName,
      namespace: options.namespace,
      annotations: {
        'karpenter.sh/do-not-disrupt': 'true',
      },
      labels: {
        app: 'opsiforce-agent',
        ...(options.projectId ? { 'opsiforce.io/project-id': options.projectId } : {}),
        ...(options.environmentId ? { 'opsiforce.io/environment-id': options.environmentId } : {}),
      },
    },
    spec: {
      ...(options.nodeSelector && Object.keys(options.nodeSelector).length > 0
        ? { nodeSelector: options.nodeSelector }
        : {}),
      ...(options.tolerations && options.tolerations.length > 0 ? { tolerations: options.tolerations } : {}),
      ...(options.affinity && Object.keys(options.affinity).length > 0 ? { affinity: options.affinity } : {}),
      ...(options.imagePullSecrets && options.imagePullSecrets.length > 0
        ? { imagePullSecrets: options.imagePullSecrets }
        : {}),
      initContainers: [
        {
          name: 'init-config',
          image: options.agentContainerImage,
          imagePullPolicy: options.imagePullPolicy,
          env: [{ name: 'AGENT_NAME', value: resolvedAgentName }],
          command: [
            'sh',
            '-c',
            'set -e; ' +
              `AGENT="\${AGENT_NAME:-app-builder}"; ` +
              'mkdir -p /workspace/.xdg/code-server; ' +
              'AGENT_NAME=$AGENT WORKSPACE=/workspace agent-workspace-migrate --sync-agent-files',
          ],
          volumeMounts,
        },
      ],
      containers: [
        {
          name: 'opencode',
          image: options.agentContainerImage,
          imagePullPolicy: options.imagePullPolicy,
          workingDir: '/workspace',
          ports: [{ containerPort: options.agentPort }, { containerPort: appPort }, { containerPort: 8080 }],
          env: [
            { name: 'XDG_DATA_HOME', value: '/workspace/.xdg/share' },
            { name: 'XDG_CONFIG_HOME', value: '/workspace/.xdg/config' },
            { name: 'XDG_CACHE_HOME', value: '/workspace/.xdg/cache' },
            { name: 'XDG_STATE_HOME', value: '/workspace/.xdg/state' },
            { name: 'AGENT_NAME', value: resolvedAgentName },
            { name: 'APP_PORT', value: String(appPort) },
            ...(options.controlToken
              ? [
                  { name: 'OPSIFORCE_CONTROL_TOKEN', value: options.controlToken },
                  ...(options.controlPort ? [{ name: 'CONTROL_PORT', value: String(options.controlPort) }] : []),
                ]
              : []),
            ...(options.opsiforceEnv ? [{ name: 'OPSIFORCE_ENV', value: options.opsiforceEnv }] : []),
            ...(routingId && options.appsHostname
              ? [
                  {
                    name: 'APP_PUBLIC_URL',
                    value: appPublicUrl(routingId, options.environmentSlug, options.appsHostname),
                  },
                ]
              : []),
            ...(options.bifrostApiKey && options.bifrostProxyUrl
              ? [
                  { name: 'OPENAI_API_KEY', value: options.bifrostApiKey },
                  { name: 'OPENAI_BASE_URL', value: options.bifrostProxyUrl },
                  { name: 'ANTHROPIC_API_KEY', value: options.bifrostApiKey },
                  {
                    name: 'ANTHROPIC_BASE_URL',
                    value: options.bifrostProxyUrl.replace(/\/v1\/?$/, '/anthropic/v1'),
                  },
                  ...(options.bifrostBackendApiKey
                    ? [
                        {
                          name: 'APP_LLM_API_KEY',
                          value: options.bifrostBackendApiKey,
                        },
                        {
                          name: 'APP_LLM_BASE_URL',
                          value: options.bifrostProxyUrl,
                        },
                      ]
                    : []),
                ]
              : options.openaiApiKey
                ? [{ name: 'OPENAI_API_KEY', value: options.openaiApiKey }]
                : []),
            ...(options.gatewayApiKey && options.gatewayUrl
              ? [
                  {
                    name: 'SERVICE_GATEWAY_API_KEY',
                    value: options.gatewayApiKey,
                  },
                  { name: 'SERVICE_GATEWAY_URL', value: options.gatewayUrl },
                  {
                    name: 'EXTERNAL_SERVICES_URL',
                    value: options.externalServicesUrl ?? '',
                  },
                ]
              : []),
            ...(options.platformApiKey && options.platformApiUrl && options.runtimeProxyUrl
              ? [
                  { name: 'OPSIFORCE_API_KEY', value: options.platformApiKey },
                  { name: 'OPSIFORCE_API_URL', value: options.platformApiUrl },
                  { name: 'OPSIFORCE_RUNTIME_PROXY_URL', value: options.runtimeProxyUrl },
                ]
              : []),
          ],
          volumeMounts,
          readinessProbe: {
            httpGet: {
              path: '/api/health',
              port: options.agentPort,
            },
            initialDelaySeconds: 5,
            periodSeconds: 5,
            timeoutSeconds: 5,
          },
          resources: options.resources,
        },
      ],
      volumes: [buildStorageVolume(options)],
      restartPolicy: 'Always',
    },
  };
}

function buildStorageVolume(options: PodTemplateOptions): k8s.V1Volume {
  if (options.storageType === 'hostPath') {
    return {
      name: 'workspace',
      hostPath: {
        path: options.storageMountPath,
        type: 'DirectoryOrCreate',
      },
    };
  }

  return {
    name: 'workspace',
    persistentVolumeClaim: {
      claimName: options.cephfsPvcName,
    },
  };
}
