import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from '../common/k8s-client';
import { appAuthRouteRules, OIDC_CALLBACK_PATH, type AppAuthRouteTarget } from './app-auth-route';
import type { SignInProviderConnection } from '../sign-in-provider/sign-in-provider.types';
import { ProjectAuthOidcConfig } from './project.types';

const TRAEFIK_GROUP = 'traefik.io';
const TRAEFIK_VERSION = 'v1alpha1';
const MIDDLEWARES_PLURAL = 'middlewares';
const INGRESSROUTES_PLURAL = 'ingressroutes';

const GATE_PREFIX = 'opsiforce-project-';
const middlewareName = (routingId: string) => `${GATE_PREFIX}${routingId}-oidc`;
const ingressRouteName = (routingId: string) => `${GATE_PREFIX}${routingId}`;
const signInResourceName = (providerId: string) => `opsiforce-sign-in-${providerId}`;
const signInPath = (providerId: string) => `/p/${providerId}`;

const SIGN_IN_HOST_LABEL = 'auth';
const SIGN_IN_COOKIE_PREFIX = '_opsiforce_sp_';

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
  CookieNamePrefix?: string;
  Scopes?: string[];
  Authorization?: { AssertClaims: TraefikOidcAssertClaim[]; CheckOnEveryRequest?: boolean };
  SessionCookie?: { Secure: boolean; Domain?: string };
  Headers?: Array<{ Name: string; Value: string }>;
  BypassAuthenticationRule?: string;
}

interface MiddlewareExtras {
  headers?: Array<{ Name: string; Value: string }>;
  assertClaims?: TraefikOidcAssertClaim[];
  bypassAuthPaths?: string[];
  signIn?: { callbackUri: string; cookieNamePrefix: string; cookieDomain: string };
}

const IDENTITY_HEADERS: Array<{ Name: string; Value: string }> = [
  { Name: 'X-Oidc-Subject', Value: '{{ .claims.sub }}' },
  { Name: 'X-Oidc-Email', Value: '{{ .claims.email }}' },
];

const signInIdentityHeaders = (groupsClaim: string | undefined): Array<{ Name: string; Value: string }> => [
  { Name: 'X-Oidc-Subject', Value: '{{ .claims.sub }}' },
  {
    Name: 'X-Oidc-Email',
    Value: '{{ with .claims.email }}{{ . }}{{ else }}{{ with .claims.preferred_username }}{{ . }}{{ end }}{{ end }}',
  },
  { Name: 'X-Oidc-Username', Value: '{{ with .claims.preferred_username }}{{ . }}{{ end }}' },
  { Name: 'X-Oidc-Groups', Value: groupsClaim ? claimAsJsonArray(groupsClaim) : '[]' },
];

function claimAsJsonArray(claimName: string): string {
  const descend = claimKeys(claimName)
    .map((key, i) => `{{ with index ${i === 0 ? '.claims' : '.'} ${JSON.stringify(key)} }}`)
    .join('');
  return `${descend}{{ . | mapToJsonArray }}${'{{ else }}[]{{ end }}'.repeat(claimKeys(claimName).length)}`;
}

const readsTraefikEnvOrFile = (value: string) => value.startsWith('${') && value.endsWith('}');

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

type TraefikRoute = { match: string; priority: number } & Record<string, unknown>;

interface TraefikIngressRoute {
  metadata: Record<string, unknown>;
  spec: { routes: TraefikRoute[] } & Record<string, unknown>;
}

const ROUTE_RECONCILE_ATTEMPTS = 3;

const NAMESPACED_CLAIM = /[:/]/;

function claimPath(claimName: string): string {
  return NAMESPACED_CLAIM.test(claimName) ? `['${claimName}']` : claimName;
}

function claimKeys(claimName: string): string[] {
  return NAMESPACED_CLAIM.test(claimName) ? [claimName] : claimName.split('.');
}

@Injectable()
export class ProjectAuthService {
  private readonly logger = new Logger(ProjectAuthService.name);
  private readonly customApi: k8s.CustomObjectsApi;
  private readonly namespace: string;
  private readonly appsHostname: string;
  private readonly webappServiceName: string;
  private readonly webappServicePort: number;
  private readonly pluginSecret: string;

  constructor(private readonly configService: ConfigService) {
    const kc = loadKubeConfig();
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.namespace = this.configService.getOrThrow<string>('k8sNamespace');
    this.appsHostname = this.configService.getOrThrow<string>('appsHostname');
    this.webappServiceName = this.configService.getOrThrow<string>('webappServiceName');
    this.webappServicePort = this.configService.getOrThrow<number>('webappServicePort');
    this.pluginSecret = this.configService.getOrThrow<string>('oidcPluginSecret');
  }

  private buildMiddleware(name: string, config: ProjectAuthOidcConfig, extras: MiddlewareExtras = {}) {
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
      TokenValidation: 'IdToken',
    };
    if ([provider.Url, provider.ClientId, provider.ClientSecret].some(readsTraefikEnvOrFile)) {
      throw new BadRequestException(
        'Client ID, client secret and discovery URL cannot be ${NAME} or ${file:/path} references'
      );
    }

    const plugin: TraefikOidcPluginSpec = {
      LogLevel: 'WARN',
      Secret: this.pluginSecret,
      Provider: provider,
      CallbackUri: extras.signIn?.callbackUri ?? OIDC_CALLBACK_PATH,
      Scopes: (config.scope ?? 'openid profile email').split(/\s+/).filter(Boolean),
      SessionCookie: extras.signIn ? { Secure: true, Domain: extras.signIn.cookieDomain } : { Secure: true },
    };

    if (extras.signIn) {
      plugin.CookieNamePrefix = extras.signIn.cookieNamePrefix;
    }

    if (extras.headers && extras.headers.length > 0) {
      plugin.Headers = extras.headers;
    }

    if (extras.assertClaims && extras.assertClaims.length > 0) {
      plugin.Authorization = { AssertClaims: extras.assertClaims, CheckOnEveryRequest: true };
    }

    const bypassRule = bypassRuleFromPaths(extras.bypassAuthPaths);
    if (bypassRule) {
      plugin.BypassAuthenticationRule = bypassRule;
    }

    return {
      apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
      kind: 'Middleware',
      metadata: { name, namespace: this.namespace },
      spec: { plugin: { 'traefik-oidc-auth': plugin } },
    };
  }

  private buildIngressRoute(env: AppAuthRouteTarget, middlewares: Array<{ name: string; namespace: string }>) {
    return this.ingressRoute(ingressRouteName(env.id), this.authRoutes(env, middlewares, [this.webappService()]));
  }

  private ingressRoute(name: string, routes: unknown[]) {
    return {
      apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
      kind: 'IngressRoute',
      metadata: { name, namespace: this.namespace },
      spec: { entryPoints: ['websecure'], routes },
    };
  }

  private webappService() {
    return { name: this.webappServiceName, namespace: this.namespace, port: this.webappServicePort };
  }

  private authRoutes(env: AppAuthRouteTarget, middlewares: unknown, services: unknown) {
    return appAuthRouteRules(env, this.appsHostname).map(({ match, priority }) => ({
      kind: 'Rule',
      match,
      priority,
      middlewares,
      services,
    }));
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
      const middleware = (await this.find(MIDDLEWARES_PLURAL, middlewareName(routingId))) as
        | { spec?: { plugin?: Record<string, TraefikOidcPluginSpec> } }
        | undefined;
      return middleware?.spec?.plugin?.['traefik-oidc-auth'];
    } catch (err) {
      this.logger.error(`Failed to read middleware for routing id ${routingId}`, err);
      throw err;
    }
  }

  async apply(env: AppAuthRouteTarget, config: ProjectAuthOidcConfig, bypassAuthPaths?: string[]): Promise<void> {
    const effectiveConfig = await this.preserveClientSecret(env.id, config);
    const extras: MiddlewareExtras = {
      headers: this.validatedAppHeaders(env.id, config.forwardAccessToken, bypassAuthPaths),
      bypassAuthPaths,
    };
    const mw = this.buildMiddleware(middlewareName(env.id), effectiveConfig, extras);
    const ir = this.buildIngressRoute(env, [this.oidcMiddlewareRef(env.id)]);
    await this.upsert(MIDDLEWARES_PLURAL, mw.metadata.name, mw);
    await this.upsert(INGRESSROUTES_PLURAL, ir.metadata.name, ir);
  }

  async applyProvider(
    env: AppAuthRouteTarget,
    provider: SignInProviderConnection,
    forwardAccessToken: boolean | undefined,
    bypassAuthPaths?: string[]
  ): Promise<void> {
    const mw = this.buildMiddleware(middlewareName(env.id), this.providerConfig(provider), {
      ...this.providerExtras(provider),
      headers: this.validatedAppHeaders(
        env.id,
        forwardAccessToken,
        bypassAuthPaths,
        signInIdentityHeaders(provider.groupsClaim)
      ),
      bypassAuthPaths,
    });
    const ir = this.buildIngressRoute(env, [this.oidcMiddlewareRef(env.id)]);
    await this.upsert(MIDDLEWARES_PLURAL, mw.metadata.name, mw);
    await this.upsert(INGRESSROUTES_PLURAL, ir.metadata.name, ir);
  }

  async applySignInHost(provider: SignInProviderConnection): Promise<void> {
    const name = signInResourceName(provider.id);
    const mw = this.buildMiddleware(name, this.providerConfig(provider), {
      ...this.providerExtras(provider),
      assertClaims: undefined,
    });
    const ir = this.ingressRoute(name, [
      {
        kind: 'Rule',
        match: `Host(\`${this.signInHost()}\`) && PathPrefix(\`${signInPath(provider.id)}/\`)`,
        priority: 100,
        middlewares: [{ name, namespace: this.namespace }],
        services: [this.webappService()],
      },
    ]);
    await this.upsert(MIDDLEWARES_PLURAL, name, mw);
    await this.upsert(INGRESSROUTES_PLURAL, name, ir);
  }

  async removeSignInHost(providerId: string): Promise<void> {
    await this.deleteIfExists(INGRESSROUTES_PLURAL, signInResourceName(providerId));
    await this.deleteIfExists(MIDDLEWARES_PLURAL, signInResourceName(providerId));
  }

  signInCallbackUrl(providerId: string): string {
    return `https://${this.signInHost()}${signInPath(providerId)}${OIDC_CALLBACK_PATH}`;
  }

  private signInHost(): string {
    return `${SIGN_IN_HOST_LABEL}.${this.appsHostname}`;
  }

  private providerConfig(provider: SignInProviderConnection): ProjectAuthOidcConfig {
    return {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      discoveryUrl: provider.discoveryUrl,
      scope: provider.scope,
    };
  }

  private providerExtras(provider: SignInProviderConnection): MiddlewareExtras {
    return {
      signIn: {
        callbackUri: this.signInCallbackUrl(provider.id),
        cookieNamePrefix: `${SIGN_IN_COOKIE_PREFIX}${provider.id}`,
        cookieDomain: `.${this.appsHostname}`,
      },
      assertClaims: provider.requiredClaim
        ? [
            {
              Name: claimPath(provider.requiredClaim.name),
              ...(provider.requiredClaim.values.length > 0 ? { AnyOf: provider.requiredClaim.values } : {}),
            },
          ]
        : undefined,
    };
  }

  private validatedAppHeaders(
    routingId: string,
    forwardAccessToken: unknown,
    bypassAuthPaths: string[] | undefined,
    identityHeaders = IDENTITY_HEADERS
  ) {
    if (forwardAccessToken !== undefined && typeof forwardAccessToken !== 'boolean') {
      throw new BadRequestException('forwardAccessToken must be a boolean');
    }
    if (forwardAccessToken && bypassAuthPaths?.some((p) => p.trim())) {
      throw new BadRequestException('Token forwarding cannot be combined with authentication bypass paths');
    }
    return forwardAccessToken ? [...identityHeaders, ...this.forwardingHeaders(routingId)] : identityHeaders;
  }

  async inheritAuth(fromRoutingId: string, to: AppAuthRouteTarget): Promise<string | null> {
    const sourceSpec = await this.readPluginSpec(fromRoutingId);
    if (!sourceSpec) {
      throw new Error(`Cannot inherit app auth: source middleware ${middlewareName(fromRoutingId)} not found`);
    }

    await this.applyClonedSpec(to, sourceSpec);
    const cookiePrefix = sourceSpec.CookieNamePrefix ?? '';
    return cookiePrefix.startsWith(SIGN_IN_COOKIE_PREFIX) ? cookiePrefix.slice(SIGN_IN_COOKIE_PREFIX.length) : null;
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

  private async applyClonedSpec(env: AppAuthRouteTarget, sourceSpec: TraefikOidcPluginSpec): Promise<void> {
    const clonedSpec: TraefikOidcPluginSpec = {
      ...sourceSpec,
      ...(sourceSpec.Headers?.some((h) => h.Name === 'X-Opsiforce-Access-Token')
        ? {
            Headers: [
              ...sourceSpec.Headers.filter((h) => !h.Name.startsWith('X-Opsiforce-')),
              ...this.forwardingHeaders(env.id),
            ],
          }
        : {}),
      CallbackUri: sourceSpec.CallbackUri.startsWith(`https://${this.signInHost()}/`)
        ? sourceSpec.CallbackUri
        : OIDC_CALLBACK_PATH,
    };
    const mw = {
      apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
      kind: 'Middleware',
      metadata: { name: middlewareName(env.id), namespace: this.namespace },
      spec: { plugin: { 'traefik-oidc-auth': clonedSpec } },
    };
    const ir = this.buildIngressRoute(env, [this.oidcMiddlewareRef(env.id)]);
    await this.upsert(MIDDLEWARES_PLURAL, mw.metadata.name, mw);
    await this.upsert(INGRESSROUTES_PLURAL, ir.metadata.name, ir);
  }

  private async preserveClientSecret(routingId: string, config: ProjectAuthOidcConfig): Promise<ProjectAuthOidcConfig> {
    if (config.clientSecret?.trim()) return config;
    const existing = await this.readPluginSpec(routingId);
    if (existing?.CookieNamePrefix?.startsWith(SIGN_IN_COOKIE_PREFIX)) return config;
    const preserved = existing?.Provider?.ClientSecret;
    if (!preserved) return config;
    return { ...config, clientSecret: preserved };
  }

  async reconcileRoute(env: AppAuthRouteTarget): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const route = (await this.find(INGRESSROUTES_PLURAL, ingressRouteName(env.id))) as
        | TraefikIngressRoute
        | undefined;
      if (!route) return;
      const [{ middlewares, services }] = route.spec.routes;
      const expectedRoutes = this.authRoutes(env, middlewares, services);
      if (isDeepStrictEqual(route.spec.routes, expectedRoutes)) return;
      try {
        await this.customApi.replaceNamespacedCustomObject({
          group: TRAEFIK_GROUP,
          version: TRAEFIK_VERSION,
          namespace: this.namespace,
          plural: INGRESSROUTES_PLURAL,
          name: ingressRouteName(env.id),
          body: { ...route, spec: { ...route.spec, routes: expectedRoutes } },
        });
        this.logger.log(`Rewrote the App Auth route of environment ${env.id}`);
        return;
      } catch (err) {
        const writtenMeanwhile = (err as { code?: number })?.code === 409;
        if (!writtenMeanwhile || attempt === ROUTE_RECONCILE_ATTEMPTS) throw err;
      }
    }
  }

  async remove(routingId: string): Promise<void> {
    await this.deleteIfExists(INGRESSROUTES_PLURAL, ingressRouteName(routingId));
    await this.deleteIfExists(MIDDLEWARES_PLURAL, middlewareName(routingId));
  }

  async gatedRoutingIds(): Promise<string[]> {
    const { items } = (await this.customApi.listNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: this.namespace,
      plural: INGRESSROUTES_PLURAL,
    })) as { items: Array<{ metadata: { name: string } }> };
    return items
      .map(({ metadata }) => metadata.name)
      .filter((name) => name.startsWith(GATE_PREFIX))
      .map((name) => name.slice(GATE_PREFIX.length));
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

    const existing = (await this.find(plural, name)) as { metadata?: { resourceVersion?: string } } | undefined;

    const resourceVersion = existing?.metadata?.resourceVersion;
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

  private async find(plural: string, name: string): Promise<unknown> {
    try {
      return await this.customApi.getNamespacedCustomObject({
        group: TRAEFIK_GROUP,
        version: TRAEFIK_VERSION,
        namespace: this.namespace,
        plural,
        name,
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 404) return undefined;
      throw err;
    }
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
