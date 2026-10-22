import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAuthService } from '../src/project/project-auth.service';

const kube = vi.hoisted(() => ({ createNamespacedCustomObject: vi.fn(), getNamespacedCustomObject: vi.fn() }));
vi.mock('../src/common/k8s-client', () => ({ loadKubeConfig: () => ({ makeApiClient: () => kube }) }));
const key = 'k'.repeat(32);
const config = {
  clientId: 'client',
  clientSecret: 'secret',
  discoveryUrl: 'https://issuer.example/v2.0/.well-known/openid-configuration',
};
function service(secret = key) {
  return new ProjectAuthService(
    new ConfigService({
      k8sNamespace: 'test',
      appsHostname: 'apps.example',
      webappServiceName: 'proxy',
      webappServicePort: 3002,
      oidcPluginSecret: 'cookie-encryption-secret-for-test',
      managedOidcClientId: 'managed',
      appAuthForwardingSigningKey: secret,
    })
  );
}
function spec() {
  return kube.createNamespacedCustomObject.mock.calls[0][0].body.spec.plugin['traefik-oidc-auth'];
}
beforeEach(() => {
  vi.resetAllMocks();
});
describe('per-environment forwarded token forwarding', () => {
  it('is off by default and preserves ID token validation', async () => {
    await service().apply('env-a', null, config);
    expect(spec().Headers.some((h: { Name: string }) => h.Name.includes('Access-Token'))).toBe(false);
    expect(spec().Provider.TokenValidation).toBe('IdToken');
  });
  it('round trips opt-in without returning secrets', async () => {
    const auth = service();
    await auth.apply('env-a', null, { ...config, forwardAccessToken: true });
    const plugin = spec();
    expect(plugin.Headers).toContainEqual({ Name: 'X-Opsiforce-Access-Token', Value: '{{ .accessToken }}' });
    expect(plugin.Headers).toContainEqual({ Name: 'X-Opsiforce-User-Id', Value: '{{ .claims.sub }}' });
    expect(plugin.Headers).toContainEqual({
      Name: 'X-Opsiforce-Object-Id',
      Value: '{{ with .claims.oid }}{{ . }}{{ end }}',
    });
    expect(plugin.Headers).toContainEqual({
      Name: 'X-Opsiforce-Forwarding-Proof',
      Value: createHmac('sha256', key).update('app-auth-forwarding:env-a').digest('hex'),
    });
    kube.getNamespacedCustomObject.mockResolvedValue({ spec: { plugin: { 'traefik-oidc-auth': plugin } } });
    const saved = await auth.getConfig('env-a');
    expect(saved.config?.forwardAccessToken).toBe(true);
    expect(saved.config?.clientSecret).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('Forwarding-Proof');
  });
  it('rekeys cloned environments', async () => {
    const auth = service();
    await auth.apply('env-a', null, { ...config, forwardAccessToken: true });
    const original = spec();
    kube.createNamespacedCustomObject.mockClear();
    kube.getNamespacedCustomObject.mockResolvedValue({ spec: { plugin: { 'traefik-oidc-auth': original } } });
    await auth.inheritAuth('env-a', 'env-b', null);
    expect(spec().Headers).toContainEqual({
      Name: 'X-Opsiforce-Forwarding-Proof',
      Value: createHmac('sha256', key).update('app-auth-forwarding:env-b').digest('hex'),
    });
  });
  it('rejects bypass paths and weak transport keys before writing', async () => {
    await expect(service().apply('env-a', null, { ...config, forwardAccessToken: true }, ['/public'])).rejects.toThrow(
      'bypass'
    );
    await expect(
      service('k'.repeat(31)).apply('env-a', null, { ...config, forwardAccessToken: true })
    ).rejects.toThrow('APP_AUTH_FORWARDING_SIGNING_KEY');
    expect(kube.createNamespacedCustomObject).not.toHaveBeenCalled();
  });
  it('disabling removes token and proof headers', async () => {
    await service().apply('env-a', null, { ...config, forwardAccessToken: false });
    expect(spec().Headers).toHaveLength(2);
  });
});
