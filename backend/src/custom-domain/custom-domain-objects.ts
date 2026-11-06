import { CERT_MANAGER_API_VERSION, TRAEFIK_API_VERSION, type KubeLabels } from '../common/kube-object-writer';
import { appAuthMiddlewareName } from '../project/app-auth-route';
import type { ProjectAuthMode } from '../project/project.types';
import { wwwOf } from './hostname';

export interface DomainHosts {
  id: string;
  hostname: string;
  bare: boolean;
}

export interface RoutedDomain extends DomainHosts {
  isMain: boolean;
  redirectsToMain: boolean;
}

export interface RoutedEnvironment {
  id: string;
  authMode: ProjectAuthMode;
}

export interface DomainRouting extends RoutedEnvironment {
  mainDomain: string | null;
}

export interface DomainCluster {
  namespace: string;
  webappServiceName: string;
  webappServicePort: number;
}

export const UNPROTECTED_MARKER = 'opsiforce-custom-domain-unprotected';
const UNPROTECTED_ROUTE_HEADER = 'X-Opsiforce-Unprotected-Route';

export const customDomainSignInName = (environmentId: string) => `${appAuthMiddlewareName(environmentId)}-domains`;

export const customDomainObjectName = (domainId: string) => `opsiforce-domain-${domainId}`;
export const redirectToMainName = (environmentId: string) => `opsiforce-project-${environmentId}-to-main`;
export const redirectWithoutWwwName = (environmentId: string) => `opsiforce-project-${environmentId}-without-www`;
export const customDomainSecretName = (domainId: string) => `${customDomainObjectName(domainId)}-tls`;

export const customDomainLabels = (domainId: string): KubeLabels => ({ 'opsiforce.io/custom-domain': domainId });
export const environmentLabels = (environmentId: string): KubeLabels => ({ 'opsiforce.io/environment': environmentId });

export function hostsOf(domain: Pick<DomainHosts, 'hostname' | 'bare'>): string[] {
  return domain.bare ? [domain.hostname, wwwOf(domain.hostname)] : [domain.hostname];
}

export function redirectTargetOf(
  host: string,
  domain: Pick<RoutedDomain, 'hostname' | 'redirectsToMain'>,
  mainDomain: string | null
): string | null {
  if (host !== domain.hostname) return domain.hostname;
  if (mainDomain === null || host === mainDomain || !domain.redirectsToMain) return null;
  return mainDomain;
}

function metadataOf(domain: DomainHosts, environmentId: string, namespace: string) {
  return {
    name: customDomainObjectName(domain.id),
    namespace,
    labels: { ...customDomainLabels(domain.id), ...environmentLabels(environmentId) },
  };
}

export function customDomainCertificate(
  domain: DomainHosts,
  environmentId: string,
  { namespace, issuer }: { namespace: string; issuer: string }
) {
  const metadata = metadataOf(domain, environmentId, namespace);
  return {
    apiVersion: CERT_MANAGER_API_VERSION,
    kind: 'Certificate',
    metadata,
    spec: {
      secretName: customDomainSecretName(domain.id),
      secretTemplate: { labels: metadata.labels },
      dnsNames: hostsOf(domain),
      issuerRef: { group: 'cert-manager.io', kind: 'ClusterIssuer', name: issuer },
      privateKey: { rotationPolicy: 'Always' },
    },
  };
}

function gateOf(env: RoutedEnvironment): string {
  switch (env.authMode) {
    case 'public':
      return UNPROTECTED_MARKER;
    case 'manual':
      return appAuthMiddlewareName(env.id);
    case 'provider':
      return customDomainSignInName(env.id);
  }
}

export function customDomainIngressRoute(domain: RoutedDomain, env: DomainRouting, cluster: DomainCluster) {
  const middlewareOf = (host: string) => {
    const target = redirectTargetOf(host, domain, env.mainDomain);
    if (target === null) return gateOf(env);
    return target === domain.hostname ? redirectWithoutWwwName(env.id) : redirectToMainName(env.id);
  };
  return {
    apiVersion: TRAEFIK_API_VERSION,
    kind: 'IngressRoute',
    metadata: metadataOf(domain, env.id, cluster.namespace),
    spec: {
      entryPoints: ['websecure'],
      routes: hostsOf(domain).map((host) => ({
        kind: 'Rule',
        match: `Host(\`${host}\`)`,
        middlewares: [{ name: middlewareOf(host), namespace: cluster.namespace }],
        services: [{ name: cluster.webappServiceName, namespace: cluster.namespace, port: cluster.webappServicePort }],
      })),
      tls: { secretName: customDomainSecretName(domain.id) },
    },
  };
}

export function customDomainSignInMiddleware(environmentId: string, namespace: string, spec: object) {
  return {
    apiVersion: TRAEFIK_API_VERSION,
    kind: 'Middleware',
    metadata: { name: customDomainSignInName(environmentId), namespace, labels: environmentLabels(environmentId) },
    spec,
  };
}

export function unprotectedMarkerMiddleware(namespace: string) {
  return {
    apiVersion: TRAEFIK_API_VERSION,
    kind: 'Middleware',
    metadata: { name: UNPROTECTED_MARKER, namespace },
    spec: { headers: { customRequestHeaders: { [UNPROTECTED_ROUTE_HEADER]: '1' } } },
  };
}

export function redirectToMainMiddleware(environmentId: string, mainHostname: string, namespace: string) {
  return {
    apiVersion: TRAEFIK_API_VERSION,
    kind: 'Middleware',
    metadata: { name: redirectToMainName(environmentId), namespace, labels: environmentLabels(environmentId) },
    spec: {
      redirectRegex: { regex: '^https?://[^/]+(.*)$', replacement: `https://${mainHostname}\${1}`, permanent: false },
    },
  };
}

export function redirectWithoutWwwMiddleware(environmentId: string, namespace: string) {
  return {
    apiVersion: TRAEFIK_API_VERSION,
    kind: 'Middleware',
    metadata: { name: redirectWithoutWwwName(environmentId), namespace, labels: environmentLabels(environmentId) },
    spec: {
      redirectRegex: {
        regex: '^https?://www\\.([^/:]+)(?::\\d+)?(.*)$',
        replacement: 'https://${1}${2}',
        permanent: true,
      },
    },
  };
}

interface CertificateCondition {
  type: string;
  status: string;
  message?: string;
}

export type CertificateProgress =
  | { state: 'missing' }
  | { state: 'issuing' }
  | { state: 'ready' }
  | { state: 'failed'; reason: string };

const UNEXPLAINED_FAILURE = 'The certificate could not be issued.';

export function certificateProgress(certificate: unknown): CertificateProgress {
  if (!certificate) return { state: 'missing' };
  const conditions = (certificate as { status?: { conditions?: CertificateCondition[] } }).status?.conditions ?? [];
  const condition = (type: string) => conditions.find((candidate) => candidate.type === type);
  if (condition('Ready')?.status === 'True') return { state: 'ready' };
  const issuing = condition('Issuing');
  if (issuing?.status === 'False') return { state: 'failed', reason: issuing.message || UNEXPLAINED_FAILURE };
  return { state: 'issuing' };
}
