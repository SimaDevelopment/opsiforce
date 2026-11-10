import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appUsersClientSecret } from '../../src/app-users/app-users-client';
import { ProjectAuthService } from '../../src/project/project-auth.service';

const kube = vi.hoisted(() => ({ createNamespacedCustomObject: vi.fn(), getNamespacedCustomObject: vi.fn() }));
vi.mock('../../src/common/k8s-client', () => ({ loadKubeConfig: () => ({ makeApiClient: () => kube }) }));

const PLUGIN_SECRET = 'cookie-encryption-secret-for-test';
const DEV = { id: 'env-dev', shortId: 'envdev000000' };
const PROD = { id: 'env-prod', shortId: 'envprod00000' };

function service(overrides: Record<string, string> = {}) {
  return new ProjectAuthService(
    new ConfigService({
      k8sNamespace: 'test',
      appsHostname: 'apps.example',
      webappServiceName: 'proxy',
      webappServicePort: 3002,
      oidcPluginSecret: PLUGIN_SECRET,
      opsiforcePublicUrl: 'https://opsiforce.example',
      appUsersProviderInternalUrl: 'http://opsiforce-backend.opsiforce.svc.cluster.local:3001',
      ...overrides,
    })
  );
}

function written(kind: 'Middleware' | 'IngressRoute') {
  return kube.createNamespacedCustomObject.mock.calls.map((call) => call[0].body).find((body) => body.kind === kind);
}

const plugin = () => written('Middleware').spec.plugin['traefik-oidc-auth'];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('the App Users gate', () => {
  it('points the environment at the in-cluster provider with the environment as its client', async () => {
    await service().applyAppUsers(DEV);

    expect(plugin().Provider).toMatchObject({
      Url: 'http://opsiforce-backend.opsiforce.svc.cluster.local:3001/api/app-auth',
      ClientId: 'env-dev',
      ClientSecret: appUsersClientSecret(PLUGIN_SECRET, 'env-dev'),
      UsePkce: true,
      ValidateAudience: true,
      ValidateIssuer: true,
      TokenValidation: 'IdToken',
    });
    expect(plugin().CallbackUri).toBe('/oidc/callback');
    expect(plugin().LogoutUri).toBe('/oidc/logout');
    expect(written('IngressRoute').spec.routes[0].match).toContain('envdev000000');
  });

  it('falls back to the public issuer when no in-cluster address is set', async () => {
    await service({ appUsersProviderInternalUrl: '' }).applyAppUsers(DEV);

    expect(plugin().Provider.Url).toBe('https://opsiforce.example/api/app-auth');
  });

  it('forwards who signed in, including their roles, and keeps paths that skip sign-in', async () => {
    await service().applyAppUsers(DEV, ['/health']);

    expect(plugin().Headers).toEqual([
      { Name: 'X-Oidc-Subject', Value: '{{ .claims.sub }}' },
      { Name: 'X-Oidc-Email', Value: '{{ .claims.email }}' },
      { Name: 'X-Oidc-Name', Value: '{{ with .claims.name }}{{ . }}{{ end }}' },
      { Name: 'X-Oidc-Roles', Value: '{{ with index .claims "roles" }}{{ . | mapToJsonArray }}{{ else }}[]{{ end }}' },
    ]);
    expect(plugin().BypassAuthenticationRule).toBe("PathPrefix('/health')");
  });

  it('gives every environment a different client secret', () => {
    expect(appUsersClientSecret(PLUGIN_SECRET, 'env-a')).not.toBe(appUsersClientSecret(PLUGIN_SECRET, 'env-b'));
    expect(appUsersClientSecret(PLUGIN_SECRET, 'env-a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seeds a published environment with its own client and Development’s paths that skip sign-in', async () => {
    const auth = service();
    await auth.applyAppUsers(DEV, ['/public']);
    const development = plugin();
    kube.createNamespacedCustomObject.mockClear();
    kube.getNamespacedCustomObject.mockResolvedValue({ spec: { plugin: { 'traefik-oidc-auth': development } } });

    await auth.inheritAppUsers(DEV.id, PROD);

    expect(written('Middleware').metadata.name).toBe('opsiforce-project-env-prod-oidc');
    expect(plugin().Provider.ClientId).toBe('env-prod');
    expect(plugin().Provider.ClientSecret).toBe(appUsersClientSecret(PLUGIN_SECRET, 'env-prod'));
    expect(plugin().BypassAuthenticationRule).toBe("PathPrefix('/public')");
  });

  it.each([['oidcPluginSecret'], ['opsiforcePublicUrl']])('is refused without %s', async (missing) => {
    await expect(service({ [missing]: '' }).applyAppUsers(DEV)).rejects.toThrow(
      'App Users need OPSIFORCE_PUBLIC_URL and OIDC_PLUGIN_SECRET'
    );
    expect(kube.createNamespacedCustomObject).not.toHaveBeenCalled();
  });
});
