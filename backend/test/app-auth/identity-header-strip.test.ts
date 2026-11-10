import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAuthService } from '../../src/project/project-auth.service';

const kube = vi.hoisted(() => ({ createNamespacedCustomObject: vi.fn(), getNamespacedCustomObject: vi.fn() }));
vi.mock('../../src/common/k8s-client', () => ({ loadKubeConfig: () => ({ makeApiClient: () => kube }) }));

const ENV = { id: 'env-a', shortId: 'enva00000000' };
const oidc = { clientId: 'client', clientSecret: 'secret', discoveryUrl: 'https://issuer.example' };
const provider = { id: '7d1c2c4e-1b8e-4d0a-9a51-2f6a2c0f9d11', scope: 'openid', ...oidc };

function service() {
  return new ProjectAuthService(
    new ConfigService({
      k8sNamespace: 'test',
      appsHostname: 'apps.example',
      webappServiceName: 'proxy',
      webappServicePort: 3002,
      oidcPluginSecret: 'cookie-encryption-secret-for-test',
      opsiforcePublicUrl: 'https://opsiforce.example',
    })
  );
}

const writtenBodies = () => kube.createNamespacedCustomObject.mock.calls.map((call) => call[0].body);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('a caller cannot forge the identity an App Auth gate forwards', () => {
  it.each([
    ['manual', (auth: ProjectAuthService) => auth.apply(ENV, oidc, ['/public'])],
    ['provider', (auth: ProjectAuthService) => auth.applyProvider(ENV, provider, false, ['/public'])],
    ['app_users', (auth: ProjectAuthService) => auth.applyAppUsers(ENV, ['/public'])],
  ])('%s routes every request through the header strip before the OIDC Middleware', async (_mode, save) => {
    await save(service());

    const route = writtenBodies().find((body) => body.kind === 'IngressRoute');
    for (const rule of route.spec.routes) {
      expect(rule.middlewares.map((m: { name: string }) => m.name)).toEqual([
        'opsiforce-strip-identity-headers',
        'opsiforce-project-env-a-oidc',
      ]);
    }
  });

  it('blanks every identity header a gate sets, so Traefik drops what the caller sent', async () => {
    await service().writeIdentityHeaderStrip();

    const [strip] = writtenBodies();
    expect(strip.metadata).toEqual({ name: 'opsiforce-strip-identity-headers', namespace: 'test' });
    expect(strip.spec.headers.customRequestHeaders).toEqual({
      'X-Oidc-Subject': '',
      'X-Oidc-Email': '',
      'X-Oidc-Name': '',
      'X-Oidc-Role': '',
      'X-Oidc-Username': '',
      'X-Oidc-Groups': '',
    });
  });
});
