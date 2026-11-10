import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from './k8s-client';

export interface KubeObjectKind {
  readonly group: string;
  readonly version: string;
  readonly plural: string;
}

export type KubeLabels = Readonly<Record<string, string>>;

export type KubeObject = { metadata: { name: string } } & Record<string, unknown>;

const TRAEFIK = { group: 'traefik.io', version: 'v1alpha1' };
export const TRAEFIK_API_VERSION = `${TRAEFIK.group}/${TRAEFIK.version}`;
export const TRAEFIK_MIDDLEWARES: KubeObjectKind = { ...TRAEFIK, plural: 'middlewares' };
export const TRAEFIK_INGRESS_ROUTES: KubeObjectKind = { ...TRAEFIK, plural: 'ingressroutes' };

const CERT_MANAGER = { group: 'cert-manager.io', version: 'v1' };
export const CERT_MANAGER_API_VERSION = `${CERT_MANAGER.group}/${CERT_MANAGER.version}`;
export const CERT_MANAGER_CERTIFICATES: KubeObjectKind = { ...CERT_MANAGER, plural: 'certificates' };

const statusOf = (err: unknown) => (err as { code?: number } | undefined)?.code;
const isNotFound = (err: unknown) => statusOf(err) === 404;
export const isConflict = (err: unknown) => statusOf(err) === 409;

const REPLACE_ATTEMPTS = 3;

const labelSelector = (labels: KubeLabels) =>
  Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

export class KubeObjectWriter {
  private readonly customApi: k8s.CustomObjectsApi;
  private readonly coreApi: k8s.CoreV1Api;

  constructor(private readonly namespace: string) {
    const kc = loadKubeConfig();
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  async upsert(kind: KubeObjectKind, name: string, body: object): Promise<void> {
    try {
      await this.customApi.createNamespacedCustomObject({ ...this.in(kind), body });
      return;
    } catch (err) {
      if (!isConflict(err)) throw err;
    }

    const metadata = (body as { metadata?: Record<string, unknown> }).metadata ?? {};
    for (let attempt = 1; ; attempt++) {
      const existing = (await this.find(kind, name)) as { metadata?: { resourceVersion?: string } } | undefined;
      try {
        await this.replace(kind, name, {
          ...body,
          metadata: { ...metadata, resourceVersion: existing?.metadata?.resourceVersion },
        });
        return;
      } catch (err) {
        if (!isConflict(err) || attempt >= REPLACE_ATTEMPTS) throw err;
      }
    }
  }

  async replace(kind: KubeObjectKind, name: string, body: object): Promise<void> {
    await this.customApi.replaceNamespacedCustomObject({ ...this.in(kind), name, body });
  }

  async find(kind: KubeObjectKind, name: string): Promise<unknown> {
    try {
      return await this.customApi.getNamespacedCustomObject({ ...this.in(kind), name });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async list(kind: KubeObjectKind, labels?: KubeLabels): Promise<KubeObject[]> {
    const { items } = (await this.customApi.listNamespacedCustomObject({
      ...this.in(kind),
      ...(labels ? { labelSelector: labelSelector(labels) } : {}),
    })) as { items: KubeObject[] };
    return items;
  }

  async deleteIfExists(kind: KubeObjectKind, name: string): Promise<void> {
    try {
      await this.customApi.deleteNamespacedCustomObject({ ...this.in(kind), name });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async deleteByLabels(kind: KubeObjectKind, labels: KubeLabels): Promise<void> {
    for (const { metadata } of await this.list(kind, labels)) {
      await this.deleteIfExists(kind, metadata.name);
    }
  }

  async deleteSecretIfExists(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedSecret({ name, namespace: this.namespace });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private in(kind: KubeObjectKind) {
    return { group: kind.group, version: kind.version, namespace: this.namespace, plural: kind.plural };
  }
}
