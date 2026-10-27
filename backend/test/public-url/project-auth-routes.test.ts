import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAuthService } from '../../src/project/project-auth.service';

const kube = vi.hoisted(() => ({
  createNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  replaceNamespacedCustomObject: vi.fn(),
}));
vi.mock('../../src/common/k8s-client', () => ({ loadKubeConfig: () => ({ makeApiClient: () => kube }) }));

const ENV = { id: '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f', shortId: '3f2a9c1e7b4d' };
const SHORT_ID_PATTERN = 'HostRegexp(`^[a-z0-9-]+-3f2a9c1e7b4d\\.apps\\.example$`)';
const LEGACY_HOSTS =
  'Host(`3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f-prod.apps.example`) || ' +
  'Host(`3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f.apps.example`)';
const ENVIRONMENT_ID_PATTERN = 'HostRegexp(`^3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f(-[a-z0-9-]+)?\\.apps\\.example$`)';
const CURRENT_RULES = [
  { match: SHORT_ID_PATTERN, priority: 100 },
  { match: ENVIRONMENT_ID_PATTERN, priority: 101 },
];
const LEGACY_HOSTS_AT_101 = [
  { match: SHORT_ID_PATTERN, priority: 100 },
  { match: LEGACY_HOSTS, priority: 101 },
];
const LEGACY_ONLY_RULES = [{ match: LEGACY_HOSTS, priority: 100 }];
const ONE_RULE_FOR_EVERY_HOST = [{ match: `${SHORT_ID_PATTERN} || ${LEGACY_HOSTS}`, priority: 100 }];
const oidc = {
  clientId: 'client',
  clientSecret: 'secret',
  discoveryUrl: 'https://issuer.example/.well-known/openid-configuration',
};

function service() {
  return new ProjectAuthService(
    new ConfigService({
      k8sNamespace: 'test',
      appsHostname: 'apps.example',
      webappServiceName: 'proxy',
      webappServicePort: 3002,
      oidcPluginSecret: 'cookie-encryption-secret-for-test',
      managedOidcClientId: 'managed',
      managedOidcClientSecret: 'managed-secret',
      managedOidcIssuerUrl: 'https://keycloak.example/realms/opsiforce',
      appAuthForwardingSigningKey: 'k'.repeat(32),
    })
  );
}

type Rules = Array<{ match: string; priority: number }>;

function writtenRouteRules(): Rules[] {
  return [
    ...kube.createNamespacedCustomObject.mock.calls.map(([request]) => request),
    ...kube.replaceNamespacedCustomObject.mock.calls.map(([request]) => request),
  ]
    .filter((request) => request.body.kind === 'IngressRoute')
    .map((request) =>
      request.body.spec.routes.map((route: { match: string; priority: number }) => ({
        match: route.match,
        priority: route.priority,
      }))
    );
}

function existingRoute(rules: Rules) {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: { name: `opsiforce-project-${ENV.id}`, namespace: 'test', resourceVersion: '7' },
    spec: {
      entryPoints: ['websecure'],
      routes: rules.map(({ match, priority }) => ({
        kind: 'Rule',
        match,
        priority,
        middlewares: [{ name: `opsiforce-project-${ENV.id}-oidc`, namespace: 'test' }],
        services: [{ name: 'proxy', namespace: 'test', port: 3002 }],
      })),
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('every App Auth route write matches the App by pattern', () => {
  it('saving manual App Auth', async () => {
    await service().apply(ENV, oidc);
    expect(writtenRouteRules()).toEqual([CURRENT_RULES]);
  });

  it('saving managed App Auth', async () => {
    await service().applyManaged(ENV, 'example-org');
    expect(writtenRouteRules()).toEqual([CURRENT_RULES]);
  });

  it('inheriting App Auth at first publish', async () => {
    const auth = service();
    await auth.apply({ ...ENV, id: 'source-env', shortId: 'source000000' }, oidc);
    const sourceMiddleware = kube.createNamespacedCustomObject.mock.calls[0][0].body;
    kube.createNamespacedCustomObject.mockClear();
    kube.getNamespacedCustomObject.mockResolvedValue(sourceMiddleware);

    await auth.inheritAuth('source-env', ENV);

    expect(writtenRouteRules()).toEqual([CURRENT_RULES]);
  });

  it('inheriting managed App Auth whose source middleware is gone', async () => {
    kube.getNamespacedCustomObject.mockRejectedValue({ code: 404 });
    await service().inheritAuth('source-env', ENV, 'example-org');
    expect(writtenRouteRules()).toEqual([CURRENT_RULES]);
  });
});

describe('reconciling an App Auth route at startup', () => {
  it('replaces a route whose rule predates the pattern, keeping its middleware', async () => {
    kube.getNamespacedCustomObject.mockResolvedValue(existingRoute(LEGACY_ONLY_RULES));

    await service().reconcileRoute(ENV);

    expect(kube.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const [{ body, plural }] = kube.replaceNamespacedCustomObject.mock.calls[0];
    expect(plural).toBe('ingressroutes');
    expect(body).toEqual(existingRoute(CURRENT_RULES));
    expect(kube.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('splits a route that matches every host in one rule, so its legacy hosts outrank the pattern', async () => {
    kube.getNamespacedCustomObject.mockResolvedValue(existingRoute(ONE_RULE_FOR_EVERY_HOST));

    await service().reconcileRoute(ENV);

    expect(kube.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1);
    expect(kube.replaceNamespacedCustomObject.mock.calls[0][0].body).toEqual(existingRoute(CURRENT_RULES));
  });

  it('replaces exact legacy hosts with the environment id pattern, which also covers its redirects', async () => {
    kube.getNamespacedCustomObject.mockResolvedValue(existingRoute(LEGACY_HOSTS_AT_101));

    await service().reconcileRoute(ENV);

    expect(kube.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1);
    expect(kube.replaceNamespacedCustomObject.mock.calls[0][0].body).toEqual(existingRoute(CURRENT_RULES));
  });

  it('leaves a current route untouched', async () => {
    kube.getNamespacedCustomObject.mockResolvedValue(existingRoute(CURRENT_RULES));
    await service().reconcileRoute(ENV);
    expect(kube.replaceNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('never reads or writes the OIDC Middleware', async () => {
    kube.getNamespacedCustomObject.mockResolvedValue(existingRoute(LEGACY_ONLY_RULES));
    await service().reconcileRoute(ENV);
    const touched = [
      ...kube.getNamespacedCustomObject.mock.calls,
      ...kube.replaceNamespacedCustomObject.mock.calls,
    ].map(([request]) => request.plural);
    expect(touched).not.toContain('middlewares');
  });

  it('creates nothing for an environment without a route', async () => {
    kube.getNamespacedCustomObject.mockRejectedValue({ code: 404 });
    await service().reconcileRoute(ENV);
    expect(kube.createNamespacedCustomObject).not.toHaveBeenCalled();
    expect(kube.replaceNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('settles when another replica replaced the route first', async () => {
    kube.getNamespacedCustomObject
      .mockResolvedValueOnce(existingRoute(LEGACY_ONLY_RULES))
      .mockResolvedValueOnce(existingRoute(CURRENT_RULES));
    kube.replaceNamespacedCustomObject.mockRejectedValueOnce({ code: 409 });

    await expect(service().reconcileRoute(ENV)).resolves.toBeUndefined();

    expect(kube.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1);
  });
});
