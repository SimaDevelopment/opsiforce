import { readFileSync } from 'fs';
import { join } from 'path';

function parseJsonEnv<T>(env: string | undefined, fallback: T): T {
  if (!env) return fallback;
  try {
    return JSON.parse(env) as T;
  } catch {
    return fallback;
  }
}

function parseBooleanEnv(env: string | undefined, fallback: boolean): boolean {
  if (!env) return fallback;
  return env === 'true' || env === '1';
}

const QUANTITY_MULTIPLIERS: Record<string, number> = {
  '': 1,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
};

function parseQuantityEnv(env: string | undefined): number | null {
  if (env === undefined || env.trim() === '') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([KMGTP]i?)?$/.exec(env.trim());
  if (!match) return null;
  const bytes = Number(match[1]) * QUANTITY_MULTIPLIERS[match[2] ?? ''];
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function parseIntOrNull(env: string | undefined): number | null {
  if (env === undefined || env === '') return null;
  const parsed = parseInt(env, 10);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return parsed;
}

const platformVersion = JSON.parse(readFileSync(join(process.cwd(), 'platform-version.json'), 'utf8'))
  .version as string;

function resolveAgentImageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), '..', 'agent-config', 'agent-image-version.json'), 'utf8'))
      .version as string;
  } catch {
    return platformVersion;
  }
}

const agentImageVersion = resolveAgentImageVersion();

function resolveAgentContainerImage(): string {
  if (process.env.AGENT_CONTAINER_IMAGE) return process.env.AGENT_CONTAINER_IMAGE;
  return `opsiforce-agent:${agentImageVersion}`;
}

export const configuration = () => {
  return {
    databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/opsiforce',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    k8sNamespace: process.env.K8S_NAMESPACE || 'opsiforce',
    poolSizeOverride: parseIntOrNull(process.env.POOL_SIZE_OVERRIDE),
    agentContainerImage: resolveAgentContainerImage(),
    agentPort: parseInt(process.env.AGENT_PORT || '4096', 10),
    agentControlPort: parseInt(process.env.AGENT_CONTROL_PORT || '4910', 10),
    agentWakeHoldMs: parseInt(process.env.AGENT_WAKE_HOLD_MS || '30000', 10),
    agentWakePollMs: parseInt(process.env.AGENT_WAKE_POLL_MS || '1000', 10),
    appPort: parseInt(process.env.APP_PORT || '3000', 10),
    vscodePort: parseInt(process.env.VSCODE_PORT || '8080', 10),
    dbViewerPort: parseInt(process.env.DB_VIEWER_PORT || '8081', 10),
    cephfsPvcName: process.env.CEPHFS_PVC_NAME || 'opsiforce-cephfs',
    storageType: (process.env.STORAGE_TYPE || 'cephfs') as 'cephfs' | 'hostPath',
    agentContainerImagePullPolicy: process.env.AGENT_CONTAINER_IMAGE_PULL_POLICY || 'IfNotPresent',
    platformVersion: platformVersion,
    agentImageVersion: agentImageVersion,
    arch: process.arch,
    agentNodeSelector: parseJsonEnv<Record<string, string>>(process.env.AGENT_NODE_SELECTOR, {}),
    agentTolerations: parseJsonEnv<Array<Record<string, string>>>(process.env.AGENT_TOLERATIONS, []),
    agentAffinity: parseJsonEnv<Record<string, unknown>>(process.env.AGENT_AFFINITY, {}),
    imagePullSecrets: parseJsonEnv<Array<{ name: string }>>(process.env.IMAGE_PULL_SECRETS, []),
    proxyControlToken: process.env.PROXY_CONTROL_TOKEN || 'opsiforce-local-proxy-token',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    storageMountPath: process.env.STORAGE_MOUNT_PATH || '/workspace-data',
    storageClaimBytes: parseQuantityEnv(process.env.STORAGE_CLAIM_SIZE),
    importChunkSize: parseInt(process.env.IMPORT_CHUNK_SIZE || '8388608', 10),
    gotenbergUrl: process.env.GOTENBERG_URL || 'http://opsiforce-gotenberg:3006',
    bifrostProxyUrl: process.env.BIFROST_PROXY_URL || '',
    bifrostPodProxyUrl: process.env.BIFROST_POD_PROXY_URL || process.env.BIFROST_PROXY_URL || '',
    bifrostAdminUsername: process.env.BIFROST_ADMIN_USERNAME || '',
    bifrostAdminPassword: process.env.BIFROST_ADMIN_PASSWORD || '',
    workspaceCleanupRetentionDays: 7,
    exportRetentionMinutes: parseInt(process.env.EXPORT_RETENTION_MINUTES || '300', 10),
    requestLogRetentionDays: parseInt(process.env.REQUEST_LOG_RETENTION_DAYS || '3', 10),
    gatewayUrl: process.env.SERVICE_GATEWAY_URL || 'http://opsiforce-backend:3001/api/gateway',
    externalServicesUrl:
      process.env.EXTERNAL_SERVICES_URL || 'http://opsiforce-backend:3001/api/external-services/agent',
    agentWorkspaceUpdateOnStartup: parseBooleanEnv(process.env.AGENT_WORKSPACE_UPDATE_ON_STARTUP, true),
    agentUpdateJobTimeoutMs: parseInt(process.env.AGENT_UPDATE_JOB_TIMEOUT_MS || '1800000', 10),
    mailgunApiKey: process.env.MAILGUN_API_KEY || '',
    mailgunDomain: process.env.MAILGUN_DOMAIN || '',
    mailgunReceiveDomain: process.env.MAILGUN_RECEIVE_DOMAIN || process.env.MAILGUN_DOMAIN || '',
    mailgunWebhookSigningKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY || '',
    mailgunSender: process.env.MAILGUN_SENDER || '',
    mailgunUrl: process.env.MAILGUN_URL || '',
    whapiApiUrl: process.env.WHAPI_API_URL || 'https://gate.whapi.cloud',
    externalServicesWebhookBaseUrl: process.env.EXTERNAL_SERVICES_WEBHOOK_BASE_URL || '',
    externalServicesEncryptionKey: process.env.EXTERNAL_SERVICES_ENCRYPTION_KEY || '',
    appsHostname: process.env.APPS_HOSTNAME || 'apps.opsiforce.localtest.me',
    webappServiceName: process.env.WEBAPP_SERVICE_NAME || 'proxy-app',
    webappServicePort: parseInt(process.env.WEBAPP_SERVICE_PORT || '3002', 10),
    oidcPluginSecret: process.env.OIDC_PLUGIN_SECRET || '',
    managedOidcClientId: process.env.MANAGED_OIDC_CLIENT_ID || 'opsiforce-apps',
    managedOidcClientSecret: process.env.MANAGED_OIDC_CLIENT_SECRET || '',
    managedOidcIssuerUrl: process.env.MANAGED_OIDC_ISSUER_URL || '',
    managedTenantRolePrefix: process.env.MANAGED_TENANT_ROLE_PREFIX || '',
  };
};
