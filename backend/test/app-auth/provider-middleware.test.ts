import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAuthService } from '../../src/project/project-auth.service';
import type { SignInProviderConnection } from '../../src/sign-in-provider/sign-in-provider.types';

const kube = vi.hoisted(() => ({
  createNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  deleteNamespacedCustomObject: vi.fn(),
}));
vi.mock('../../src/common/k8s-client', () => ({ loadKubeConfig: () => ({ makeApiClient: () => kube }) }));

const FORWARDING_KEY = 'k'.repeat(32);
const ENV_A = { id: 'env-a', shortId: 'enva00000000' };
const ENV_B = { id: 'env-b', shortId: 'envb00000000' };

const PROVIDER_ID = '7d1c2c4e-1b8e-4d0a-9a51-2f6a2c0f9d11';
const CALLBACK = `https://auth.apps.example/p/${PROVIDER_ID}/oidc/callback`;

const provider: SignInProviderConnection = {
  id: PROVIDER_ID,
  discoveryUrl: 'https://login.microsoftonline.com/example-org/v2.0/.well-known/openid-configuration',
  clientId: 'example-client',
  clientSecret: 'example-secret',
  scope: 'openid profile email',
};

function service() {
  return new ProjectAuthService(
    new ConfigService({
      k8sNamespace: 'opsiforce',
      appsHostname: 'apps.example',
      webappServiceName: 'proxy-app',
      webappServicePort: 3002,
      oidcPluginSecret: 'cookie-encryption-secret-for-test',
      appAuthForwardingSigningKey: FORWARDING_KEY,
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

describe('an App protected by a Sign-in provider', () => {
  it("runs the Traefik OIDC plugin on the App's hosts with the provider's settings and its one callback", async () => {
    await service().applyProvider(ENV_A, provider, false);
    expect(written('Middleware').metadata.name).toBe('opsiforce-project-env-a-oidc');
    expect(plugin().Provider).toMatchObject({
      Url: 'https://login.microsoftonline.com/example-org/v2.0',
      ClientId: 'example-client',
      ClientSecret: 'example-secret',
      UsePkce: true,
      TokenValidation: 'IdToken',
    });
    expect(plugin().CallbackUri).toBe(CALLBACK);
    expect(plugin().CookieNamePrefix).toBe(`_opsiforce_sp_${PROVIDER_ID}`);
    expect(plugin().SessionCookie).toEqual({ Secure: true, Domain: '.apps.example' });
    expect(plugin().Scopes).toEqual(['openid', 'profile', 'email']);
    expect(plugin().Authorization).toBeUndefined();
    expect(written('IngressRoute').metadata.name).toBe('opsiforce-project-env-a');
  });

  it('passes the identity headers and an empty groups array when the provider names no groups claim', async () => {
    await service().applyProvider(ENV_A, provider, false);
    const headers = Object.fromEntries(plugin().Headers.map((h: { Name: string; Value: string }) => [h.Name, h.Value]));
    expect(Object.keys(headers)).toEqual(['X-Oidc-Subject', 'X-Oidc-Email', 'X-Oidc-Username', 'X-Oidc-Groups']);
    expect(headers['X-Oidc-Groups']).toBe('[]');
  });

  it.each([
    ['groups', '{{ with index .claims "groups" }}{{ . | mapToJsonArray }}{{ else }}[]{{ end }}'],
    [
      'realm_access.roles',
      '{{ with index .claims "realm_access" }}{{ with index . "roles" }}{{ . | mapToJsonArray }}{{ else }}[]{{ end }}{{ else }}[]{{ end }}',
    ],
    [
      'https://example.com/roles',
      '{{ with index .claims "https://example.com/roles" }}{{ . | mapToJsonArray }}{{ else }}[]{{ end }}',
    ],
    ['cognito:groups', '{{ with index .claims "cognito:groups" }}{{ . | mapToJsonArray }}{{ else }}[]{{ end }}'],
    [
      'resource_access.example-org-apps.roles',
      '{{ with index .claims "resource_access" }}{{ with index . "example-org-apps" }}{{ with index . "roles" }}{{ . | mapToJsonArray }}{{ else }}[]{{ end }}{{ else }}[]{{ end }}{{ else }}[]{{ end }}',
    ],
  ])('sends the %s claim to the App as the groups header', async (groupsClaim, template) => {
    await service().applyProvider(ENV_A, { ...provider, groupsClaim }, false);
    const groups = plugin().Headers.find((h: { Name: string }) => h.Name === 'X-Oidc-Groups');
    expect(groups.Value).toBe(template);
  });

  it('asserts the required claim on every request', async () => {
    await service().applyProvider(ENV_A, { ...provider, requiredClaim: { name: 'groups', values: ['staff'] } }, false);
    expect(plugin().Authorization).toEqual({
      AssertClaims: [{ Name: 'groups', AnyOf: ['staff'] }],
      CheckOnEveryRequest: true,
    });
  });

  it.each([
    ['cognito:groups', "['cognito:groups']"],
    ['urn:zitadel:iam:org:project:roles', "['urn:zitadel:iam:org:project:roles']"],
    ['realm_access.roles', 'realm_access.roles'],
    ['resource_access.example-org-apps.roles', 'resource_access.example-org-apps.roles'],
  ])('writes the claim %s so the plugin can find it', async (name, path) => {
    await service().applyProvider(ENV_A, { ...provider, requiredClaim: { name, values: ['staff'] } }, false);
    expect(plugin().Authorization.AssertClaims).toEqual([{ Name: path, AnyOf: ['staff'] }]);
  });

  it('quotes a namespaced claim and asserts only presence when no values are listed', async () => {
    await service().applyProvider(
      ENV_A,
      { ...provider, requiredClaim: { name: 'https://example.com/roles', values: [] } },
      false
    );
    expect(plugin().Authorization.AssertClaims).toEqual([{ Name: "['https://example.com/roles']" }]);
  });

  it('keeps bypass paths and token forwarding per environment', async () => {
    await service().applyProvider(ENV_A, provider, false, ['/public']);
    expect(plugin().BypassAuthenticationRule).toBe("PathPrefix('/public')");

    vi.resetAllMocks();
    await service().applyProvider(ENV_A, provider, true);
    expect(plugin().Headers).toContainEqual({
      Name: 'X-Opsiforce-Forwarding-Proof',
      Value: createHmac('sha256', FORWARDING_KEY).update('app-auth-forwarding:env-a').digest('hex'),
    });
    expect(plugin().Headers).toContainEqual({ Name: 'X-Opsiforce-Access-Token', Value: '{{ .accessToken }}' });
  });

  it('refuses token forwarding together with bypass paths', async () => {
    await expect(service().applyProvider(ENV_A, provider, true, ['/public'])).rejects.toThrow(
      'Token forwarding cannot be combined with authentication bypass paths'
    );
  });
});

describe("a Sign-in provider's callback route", () => {
  it('runs the same plugin settings on the sign-in host under the provider path', async () => {
    await service().applySignInHost(provider);
    expect(written('Middleware').metadata.name).toBe(`opsiforce-sign-in-${PROVIDER_ID}`);
    expect(plugin()).toMatchObject({
      CallbackUri: CALLBACK,
      CookieNamePrefix: `_opsiforce_sp_${PROVIDER_ID}`,
      SessionCookie: { Secure: true, Domain: '.apps.example' },
    });
    const route = written('IngressRoute').spec.routes[0];
    expect(route.match).toBe(`Host(\`auth.apps.example\`) && PathPrefix(\`/p/${PROVIDER_ID}/\`)`);
    expect(route.services).toEqual([{ name: 'proxy-app', namespace: 'opsiforce', port: 3002 }]);
  });

  it('leaves the required claim to the App, so a refused visitor gets the 403 where its Logout works', async () => {
    await service().applySignInHost({ ...provider, requiredClaim: { name: 'groups', values: ['staff'] } });
    expect(plugin().Authorization).toBeUndefined();
  });

  it("refuses a client ID or secret the plugin would expand from Traefik's own files", async () => {
    await expect(
      service().applySignInHost({
        ...provider,
        clientSecret: '${file:/var/run/secrets/kubernetes.io/serviceaccount/token}',
      })
    ).rejects.toThrow('${file:/path}');
    await expect(
      service().applyProvider(ENV_A, { ...provider, clientId: '${KUBERNETES_SERVICE_HOST}' }, false)
    ).rejects.toThrow('${file:/path}');
    expect(kube.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('removes both resources', async () => {
    await service().removeSignInHost(PROVIDER_ID);
    expect(kube.deleteNamespacedCustomObject.mock.calls.map((call) => call[0].name)).toEqual([
      `opsiforce-sign-in-${PROVIDER_ID}`,
      `opsiforce-sign-in-${PROVIDER_ID}`,
    ]);
  });

  it('stays the callback when a published environment clones the middleware', async () => {
    const auth = service();
    await auth.applyProvider(ENV_A, provider, false);
    const original = plugin();
    kube.createNamespacedCustomObject.mockClear();
    kube.getNamespacedCustomObject.mockResolvedValue({ spec: { plugin: { 'traefik-oidc-auth': original } } });
    expect(await auth.inheritAuth('env-a', ENV_B)).toBe(PROVIDER_ID);
    expect(written('Middleware').metadata.name).toBe('opsiforce-project-env-b-oidc');
    expect(plugin().CallbackUri).toBe(CALLBACK);
    expect(plugin().CookieNamePrefix).toBe(`_opsiforce_sp_${PROVIDER_ID}`);
  });
});
