import { createHmac } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import { appCanonicalHost } from '../common/app-host';
import { loadKubeConfig } from '../common/k8s-client';
import { ProjectAuthOidcConfig } from './project.types';

const TRAEFIK_GROUP = 'traefik.io';
const TRAEFIK_VERSION = 'v1alpha1';
const MIDDLEWARES_PLURAL = 'middlewares';
const INGRESSROUTES_PLURAL = 'ingressroutes';

const middlewareName = (routingId: string) => `opsiforce-project-${routingId}-oidc`;
const ingressRouteName = (routingId: string) => `opsiforce-project-${routingId}`;

const OIDC_CALLBACK_PATH = '/oidc/callback';

interface TraefikOidcAssertClaim {
  Name: string;
  AnyOf?: string[];
  AllOf?: string[];
}

interface TraefikOidcPluginSpec {
  LogLevel?: string;
  Secret: string;
  Provider: {
    Url: string;
    ClientId: string;
    ClientSecret: string;
    UsePkce: boolean;
    ValidateAudience: boolean;
    ValidateIssuer: boolean;
    TokenValidation: string;
  };
  CallbackUri: string;
  Scopes?: string[];
  Authorization?: { AssertClaims: TraefikOidcAssertClaim[] };
  SessionCookie?: { Secure: boolean };
  Headers?: Array<{ Name: string; Value: string }>;
  BypassAuthenticationRule?: string;
}

interface MiddlewareExtras {
  headers?: Array<{ Name: string; Value: string }>;
  assertClaims?: TraefikOidcAssertClaim[];
  bypassAuthPaths?: string[];
  tokenValidation?: 'IdToken' | 'AccessToken' | 'Introspection';
}

const MANUAL_HEADERS: Array<{ Name: string; Value: string }> = [
  { Name: 'X-Oidc-Subject', Value: '{{ .claims.sub }}' },
  { Name: 'X-Oidc-Email', Value: '{{ .claims.email }}' },
];

function bypassRuleFromPaths(paths: string[] | undefined): string | undefined {
  if (!paths) return undefined;
  const safe = paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/'/g, ''));
  if (safe.length === 0) return undefined;
  return safe.map((p) => `PathPrefix('${p}')`).join(' || ');
}

function pathsFromBypassRule(rule: string | undefined): string[] {
  if (!rule) return [];
  const matches = rule.match(/PathPrefix\('([^']*)'\)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice("PathPrefix('".length, -2)).filter((p) => p.length > 0);
}

type EnvironmentSlug = string | null;

@Injectable()
export class ProjectAuthService {
  private readonly logger = new Logger(ProjectAuthService.name);
  private readonly customApi: k8s.CustomObjectsApi;
  private readonly namespace: string;
  private readonly appsHostname: string;
  private readonly webappServiceName: string;
  private readonly webappServicePort: number;
  private readonly pluginSecret: string;
  private readonly managedClientId: string;
  private readonly managedClientSecret: string;
  private readonly managedIssuerUrl: string;
  private readonly managedTenantRolePrefix: string;

  constructor(private readonly configService: ConfigService) {
    const kc = loadKubeConfig();
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.namespace = this.configService.getOrThrow<string>('k8sNamespace');
    this.appsHostname = this.configService.getOrThrow<string>('appsHostname');
    this.webappServiceName = this.configService.getOrThrow<string>('webappServiceName');
    this.webappServicePort = this.configService.getOrThrow<number>('webappServicePort');
    this.pluginSecret = this.configService.getOrThrow<string>('oidcPluginSecret');
    this.managedClientId = this.configService.getOrThrow<string>('managedOidcClientId');
    this.managedClientSecret = this.configService.get<string>('managedOidcClientSecret') ?? '';
    this.managedIssuerUrl = this.configService.get<string>('managedOidcIssuerUrl') ?? '';
    this.managedTenantRolePrefix = this.configService.get<string>('managedTenantRolePrefix') ?? '';
  }

  private projectHost(routingId: string, slug: EnvironmentSlug): string {
    return appCanonicalHost(routingId, slug, this.appsHostname);
  }

  private projectHosts(routingId: string, slug: EnvironmentSlug): string[] {
    const canonical = this.projectHost(routingId, slug);
    const bare = this.projectHost(routingId, null);
    return canonical === bare ? [canonical] : [canonical, bare];
  }

  callbackUrls(routingId: string, slug: EnvironmentSlug): string[] {
    return this.projectHosts(routingId, slug).map((host) => `https://${host}${OIDC_CALLBACK_PATH}`);
  }

  private buildMiddleware(routingId: string, config: ProjectAuthOidcConfig, extras: MiddlewareExtras = {}) {
    if (!config.clientId || !config.clientSecret) {
      throw new Error('clientId and clientSecret are required');
    }
    const providerUrl = config.discoveryUrl?.replace(/\/\.well-known\/openid-configuration\/?$/, '') ?? '';
    if (!providerUrl) {
      throw new Error('discoveryUrl is required');
    }

    const provider: TraefikOidcPluginSpec['Provider'] = {
      Url: providerUrl,
      ClientId: config.clientId,
      ClientSecret: config.clientSecret,
      UsePkce: true,
      ValidateAudience: true,
      ValidateIssuer: true,
      TokenValidation: extras.tokenValidation ?? 'IdToken',
    };

    const plugin: TraefikOidcPluginSpec = {
      LogLevel: 'WARN',
      Secret: this.pluginSecret,
      Provider: provider,
      CallbackUri: OIDC_CALLBACK_PATH,
      Scopes: (config.scope ?? 'openid profile email').split(/\s+/).filter(Boolean),
      SessionCookie: { Secure: true },
    };

    if (extras.headers && extras.headers.length > 0) {
      plugin.Headers = extras.headers;
    }

    if (extras.assertClaims && extras.assertClaims.length > 0) {
      plugin.Authorization = { AssertClaims: extras.assertClaims };
    }

    const bypassRule = bypassRuleFromPaths(extras.bypassAuthPaths);
    if (bypassRule) {
      plugin.BypassAuthenticationRule = bypassRule;
    }

    return {
      apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
      kind: 'Middleware',
      metadata: { name: middlewareName(routingId), namespace: this.namespace },
      spec: { plugin: { 'traefik-oidc-auth': plugin } },
    };
  }

  private keycloakExtras(tenantName: string, clientId: string): MiddlewareExtras {
    return {
      headers: [
        { Name: 'X-Oidc-Username', Value: '{{ .claims.preferred_username }}' },
        { Name: 'X-Oidc-Subject', Value: '{{ .claims.sub }}' },
        { Name: 'X-Oidc-Email', Value: '{{ .claims.preferred_username }}' },
        {
          Name: 'X-Oidc-Realm-Roles',
          Value: '{{ index .claims "realm_access" "roles" | mapToJsonArray }}',
        },
        {
          Name: 'X-Oidc-Client-Roles',
          Value: `{{ index .claims "resource_access" "${clientId}" "roles" | mapToJsonArray }}`,
        },
      ],
      assertClaims: [
        {
          Name: 'realm_access.roles[*]',
          AnyOf: [`${this.managedTenantRolePrefix}${tenantName}`],
        },
      ],
    };
  }

  private buildIngressRoute(
    routingId: string,
    slug: EnvironmentSlug,
    middlewares: Array<{ name: string; namespace: string }>
  ) {
    const serviceRef: {
      name: string;
      namespace: string;
      port: number;
    } = {
      name: this.webappServiceName,
      namespace: this.namespace,
      port: this.webappServicePort,
    };

    const match = this.projectHosts(routingId, slug)
      .map((host) => `Host(\`${host}\`)`)
      .join(' || ');

    return {
      apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
      kind: 'IngressRoute',
      metadata: {
        name: ingressRouteName(routingId),
        namespace: this.namespace,
      },
      spec: {
        entryPoints: ['websecure'],
        routes: [
          {
            kind: 'Rule',
            match,
            priority: 100,
            middlewares,
            services: [serviceRef],
          },
        ],
      },
    };
  }

  private oidcMiddlewareRef(routingId: string) {
    return { name: middlewareName(routingId), namespace: this.namespace };
  }

  async getConfig(routingId: string): Promise<{
    config?: ProjectAuthOidcConfig;
    bypassAuthPaths: string[];
  }> {
    const plugin = await this.readPluginSpec(routingId);
    if (!plugin) return { bypassAuthPaths: [] };
    return {
      config: {
        clientId: plugin.Provider.ClientId,
        discoveryUrl: plugin.Provider.Url ? `${plugin.Provider.Url}/.well-known/openid-configuration` : undefined,
        scope: plugin.Scopes?.join(' '),
        forwardAccessToken: plugin.Headers?.some((h) => h.Name === 'X-Opsiforce-Access-Token') ?? false,
      },
      bypassAuthPaths: pathsFromBypassRule(plugin.BypassAuthenticationRule),
    };
  }

  private async readPluginSpec(routingId: string): Promise<TraefikOidcPluginSpec | undefined> {
    try {
      const resp = await this.customApi.getNamespacedCustomObject({
        group: TRAEFIK_GROUP,
        version: TRAEFIK_VERSION,
        namespace: this.namespace,
        plural: MIDDLEWARES_PLURAL,
        name: middlewareName(routingId),
      });
      return (resp as { spec?: { plugin?: Record<string, TraefikOidcPluginSpec> } })?.spec?.plugin?.[
        'traefik-oidc-auth'
      ];
    } catch (err) {
      const status = (err as { code?: number })?.code;
      if (status === 404) return undefined;
      this.logger.error(`Failed to read middleware for routing id ${routingId}`, err);
      throw err;
    }
  }

  async apply(
    routingId: string,
    slug: EnvironmentSlug,
    config: ProjectAuthOidcConfig,
    bypassAuthPaths?: string[]
  ): Promise<void> {
    if (config.forwardAccessToken !== undefined && typeof config.forwardAccessToken !== 'boolean') {
      throw new BadRequestException('forwardAccessToken must be a boolean');
    }
    if (config.forwardAccessToken && bypassAuthPaths?.some((p) => p.trim())) {
      throw new BadRequestException('Token forwarding cannot be combined with authentication bypass paths');
    }
    const effectiveConfig = await this.preserveClientSecret(routingId, config);
    const extras: MiddlewareExtras = {
      headers: config.forwardAccessToken ? [...MANUAL_HEADERS, ...this.forwardingHeaders(routingId)] : MANUAL_HEADERS,
      bypassAuthPaths,
    };
    const mw = this.buildMiddleware(routingId, effectiveConfig, extras);
    const ir = this.buildIngressRoute(routingId, slug, [this.oidcMiddlewareRef(routingId)]);
    await this.upsert(MIDDLEWARES_PLURAL, mw.metadata.name, mw);
    await this.upsert(INGRESSROUTES_PLURAL, ir.metadata.name, ir);
  }

  async applyManaged(
    routingId: string,
    slug: EnvironmentSlug,
    tenantName: string,
    bypassAuthPaths?: string[]
  ): Promise<void> {
    if (!this.managedClientSecret) {
      throw new Error('MANAGED_OIDC_CLIENT_SECRET is not set — cannot enable managed auth.');
    }
    const config: ProjectAuthOidcConfig = {
      clientId: this.managedClientId,
      clientSecret: this.managedClientSecret,
      discoveryUrl: `${this.managedIssuerUrl}/.well-known/openid-configuration`,
    };
    const extras: MiddlewareExtras = {
      ...this.keycloakExtras(tenantName, this.managedClientId),
      tokenValidation: 'AccessToken',
      bypassAuthPaths,
    };
    const mw = this.buildMiddleware(routingId, config, extras);
    const middlewares = [this.oidcMiddlewareRef(routingId)];
    const ir = this.buildIngressRoute(routingId, slug, middlewares);
    await this.upsert(MIDDLEWARES_PLURAL, mw.metadata.name, mw);
    await this.upsert(INGRESSROUTES_PLURAL, ir.metadata.name, ir);
  }

  async inheritAuth(
    fromRoutingId: string,
    toRoutingId: string,
    toSlug: EnvironmentSlug,
    managedFallbackTenantName?: string
  ): Promise<void> {
    const sourceSpec = await this.readPluginSpec(fromRoutingId);
    if (!sourceSpec) {
      if (managedFallbackTenantName) {
        await this.applyManaged(toRoutingId, toSlug, managedFallbackTenantName);
        return;
      }
      throw new Error(`Cannot inherit app auth: source middleware ${middlewareName(fromRoutingId)} not found`);
    }

    await this.applyClonedSpec(toRoutingId, toSlug, sourceSpec);
  }

  private forwardingHeaders(routingId: string) {
    const key = this.configService.get<string>('appAuthForwardingSigningKey') ?? '';
    if (key.length < 32) {
      throw new BadRequestException(
        'Token forwarding requires an APP_AUTH_FORWARDING_SIGNING_KEY shared by backend and runtime proxies (at least 32 characters)'
      );
    }
    // This transport credential never reaches generated apps or browsers.
    const proof = createHmac('sha256', key).update(`app-auth-forwarding:${routingId}`).digest('hex');
    return [
      { Name: 'X-Opsiforce-Forwarding-Proof', Value: proof },
      { Name: 'X-Opsiforce-Access-Token', Value: '{{ .accessToken }}' },
      { Name: 'X-Opsiforce-User-Id', Value: '{{ .claims.sub }}' },
      { Name: 'X-Opsiforce-Object-Id', Value: '{{ with .claims.oid }}{{ . }}{{ end }}' },
      { Name: 'X-Opsiforce-Directory-Id', Value: '{{ with .claims.tid }}{{ . }}{{ end }}' },
    ];
  }

  private async applyClonedSpec(
    routingId: string,
    slug: EnvironmentSlug,
    sourceSpec: TraefikOidcPluginSpec
  ): Promise<void> {
    const clonedSpec: TraefikOidcPluginSpec = {
      ...sourceSpec,
      ...(sourceSpec.Headers?.some((h) => h.Name === 'X-Opsiforce-Access-Token')
        ? {
            Headers: [
              ...sourceSpec.Headers.filter((h) => !h.Name.startsWith('X-Opsiforce-')),
              ...this.forwardingHeaders(routingId),
            ],
          }
        : {}),
      CallbackUri: OIDC_CALLBACK_PATH,
    };
    const mw = {
      apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
      kind: 'Middleware',
      metadata: { name: middlewareName(routingId), namespace: this.namespace },
      spec: { plugin: { 'traefik-oidc-auth': clonedSpec } },
    };
    const ir = this.buildIngressRoute(routingId, slug, [this.oidcMiddlewareRef(routingId)]);
    await this.upsert(MIDDLEWARES_PLURAL, mw.metadata.name, mw);
    await this.upsert(INGRESSROUTES_PLURAL, ir.metadata.name, ir);
  }

  private async preserveClientSecret(routingId: string, config: ProjectAuthOidcConfig): Promise<ProjectAuthOidcConfig> {
    if (config.clientSecret?.trim()) return config;
    const existing = await this.readPluginSpec(routingId);
    const preserved = existing?.Provider?.ClientSecret;
    if (!preserved) return config;
    return { ...config, clientSecret: preserved };
  }

  async remove(routingId: string): Promise<void> {
    await this.deleteIfExists(INGRESSROUTES_PLURAL, ingressRouteName(routingId));
    await this.deleteIfExists(MIDDLEWARES_PLURAL, middlewareName(routingId));
  }

  private async upsert(plural: string, name: string, body: object): Promise<void> {
    try {
      await this.customApi.createNamespacedCustomObject({
        group: TRAEFIK_GROUP,
        version: TRAEFIK_VERSION,
        namespace: this.namespace,
        plural,
        body,
      });
      return;
    } catch (err) {
      const status = (err as { code?: number })?.code;
      if (status !== 409) throw err;
    }

    const existing = (await this.customApi.getNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: this.namespace,
      plural,
      name,
    })) as { metadata?: { resourceVersion?: string } };

    const resourceVersion = existing.metadata?.resourceVersion;
    const existingMeta = (body as { metadata?: Record<string, unknown> }).metadata ?? {};
    const bodyWithVersion = {
      ...body,
      metadata: { ...existingMeta, resourceVersion },
    };

    await this.customApi.replaceNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: this.namespace,
      plural,
      name,
      body: bodyWithVersion,
    });
  }

  private async deleteIfExists(plural: string, name: string): Promise<void> {
    try {
      await this.customApi.deleteNamespacedCustomObject({
        group: TRAEFIK_GROUP,
        version: TRAEFIK_VERSION,
        namespace: this.namespace,
        plural,
        name,
      });
    } catch (err) {
      const status = (err as { code?: number })?.code;
      if (status !== 404) throw err;
    }
  }
}
