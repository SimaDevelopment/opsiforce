import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appUsersAddresses, appUsersClientSecret } from '../app-users/app-users-client';
import {
  isConflict,
  KubeObjectWriter,
  TRAEFIK_API_VERSION,
  TRAEFIK_INGRESS_ROUTES,
  TRAEFIK_MIDDLEWARES,
} from '../common/kube-object-writer';
import {
  APP_AUTH_ROUTE_PREFIX,
  appAuthMiddlewareName,
  appAuthRouteRules,
  IDENTITY_STRIP_MIDDLEWARE,
  OIDC_CALLBACK_PATH,
  type AppAuthRouteTarget,
} from './app-auth-route';
import type { SignInProviderConnection } from '../sign-in-provider/sign-in-provider.types';
import { ProjectAuthOidcConfig } from './project.types';

const ingressRouteName = (routingId: string) => `${APP_AUTH_ROUTE_PREFIX}${routingId}`;
const signInResourceName = (providerId: string) => `opsiforce-sign-in-${providerId}`;
const signInPath = (providerId: string) => `/p/${providerId}`;

const OIDC_LOGOUT_PATH = '/oidc/logout';

const SIGN_IN_HOST_LABEL = 'auth';
const SIGN_IN_COOKIE_PREFIX = '_opsiforce_sp_';
const OIDC_PLUGIN = 'traefik-oidc-auth';

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
  LogoutUri?: string;
  PostLogoutRedirectUri?: string;
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
  signOut?: boolean;
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

const APP_USERS_HEADERS: Array<{ Name: string; Value: string }> = [
  ...IDENTITY_HEADERS,
  { Name: 'X-Oidc-Name', Value: '{{ with .claims.name }}{{ . }}{{ end }}' },
  { Name: 'X-Oidc-Roles', Value: '{{ with index .claims "roles" }}{{ . | mapToJsonArray }}{{ else }}[]{{ end }}' },
];

const GATE_IDENTITY_HEADER_NAMES = [
  ...new Set([...APP_USERS_HEADERS, ...signInIdentityHeaders(undefined)].map(({ Name }) => Name)),
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

type OidcMiddleware = { spec?: { plugin?: Record<string, TraefikOidcPluginSpec> } } | undefined;

function oidcPluginOf(middleware: unknown): TraefikOidcPluginSpec | undefined {
  return (middleware as OidcMiddleware)?.spec?.plugin?.[OIDC_PLUGIN];
}

export function signInOnEachHost(environmentMiddleware: unknown) {
  const plugin = oidcPluginOf(environmentMiddleware);
  if (!plugin) return undefined;
  const onEachHost: TraefikOidcPluginSpec = {
    ...plugin,
    CallbackUri: OIDC_CALLBACK_PATH,
    SessionCookie: { Secure: true },
  };
  return { plugin: { [OIDC_PLUGIN]: onEachHost } };
}

@Injectable()
export class ProjectAuthService {
  private readonly logger = new Logger(ProjectAuthService.name);
  private readonly kube: KubeObjectWriter;
  private readonly namespace: string;
  private readonly appsHostname: string;
  private readonly webappServiceName: string;
  private readonly webappServicePort: number;
  private readonly pluginSecret: string;
  private readonly appUsersProviderUrl: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.namespace = this.configService.getOrThrow<string>('k8sNamespace');
    this.kube = new KubeObjectWriter(this.namespace);
    this.appsHostname = this.configService.getOrThrow<string>('appsHostname');
    this.webappServiceName = this.configService.getOrThrow<string>('webappServiceName');
    this.webappServicePort = this.configService.getOrThrow<number>('webappServicePort');
    this.pluginSecret = this.configService.getOrThrow<string>('oidcPluginSecret');
    this.appUsersProviderUrl = appUsersAddresses(this.configService)?.providerUrl;
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

    if (extras.signOut) {
      plugin.LogoutUri = OIDC_LOGOUT_PATH;
      plugin.PostLogoutRedirectUri = '/';
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
      apiVersion: TRAEFIK_API_VERSION,
      kind: 'Middleware',
      metadata: { name, namespace: this.namespace },
      spec: { plugin: { [OIDC_PLUGIN]: plugin } },
    };
  }

  private buildIngressRoute(env: AppAuthRouteTarget) {
    return this.ingressRoute(
      ingressRouteName(env.id),
      this.authRoutes(env, this.gateMiddlewares(env.id), [this.webappService()])
    );
  }

  private ingressRoute(name: string, routes: unknown[]) {
    return {
      apiVersion: TRAEFIK_API_VERSION,
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

  private gateMiddlewares(routingId: string) {
    return [
      { name: IDENTITY_STRIP_MIDDLEWARE, namespace: this.namespace },
      { name: appAuthMiddlewareName(routingId), namespace: this.namespace },
    ];
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
      return oidcPluginOf(await this.kube.find(TRAEFIK_MIDDLEWARES, appAuthMiddlewareName(routingId)));
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
    await this.writeGate(env, this.buildMiddleware(appAuthMiddlewareName(env.id), effectiveConfig, extras));
  }

  async applyProvider(
    env: AppAuthRouteTarget,
    provider: SignInProviderConnection,
    forwardAccessToken: boolean | undefined,
    bypassAuthPaths?: string[]
  ): Promise<void> {
    const mw = this.buildMiddleware(appAuthMiddlewareName(env.id), this.providerConfig(provider), {
      ...this.providerExtras(provider),
      headers: this.validatedAppHeaders(
        env.id,
        forwardAccessToken,
        bypassAuthPaths,
        signInIdentityHeaders(provider.groupsClaim)
      ),
      bypassAuthPaths,
    });
    await this.writeGate(env, mw);
  }

  async applyAppUsers(env: AppAuthRouteTarget, bypassAuthPaths?: string[]): Promise<void> {
    if (!this.appUsersProviderUrl || !this.pluginSecret) {
      throw new BadRequestException('App Users need OPSIFORCE_PUBLIC_URL and OIDC_PLUGIN_SECRET to be set');
    }
    const config: ProjectAuthOidcConfig = {
      clientId: env.id,
      clientSecret: appUsersClientSecret(this.pluginSecret, env.id),
      discoveryUrl: `${this.appUsersProviderUrl}/.well-known/openid-configuration`,
    };
    const extras: MiddlewareExtras = { headers: APP_USERS_HEADERS, bypassAuthPaths, signOut: true };
    await this.writeGate(env, this.buildMiddleware(appAuthMiddlewareName(env.id), config, extras));
  }

  async inheritAppUsers(fromRoutingId: string, to: AppAuthRouteTarget): Promise<void> {
    const sourceSpec = await this.readPluginSpec(fromRoutingId);
    if (!sourceSpec) {
      throw new Error(`Cannot inherit app auth: source middleware ${appAuthMiddlewareName(fromRoutingId)} not found`);
    }
    await this.applyAppUsers(to, pathsFromBypassRule(sourceSpec.BypassAuthenticationRule));
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
    await this.kube.upsert(TRAEFIK_MIDDLEWARES, name, mw);
    await this.kube.upsert(TRAEFIK_INGRESS_ROUTES, name, ir);
  }

  async removeSignInHost(providerId: string): Promise<void> {
    await this.kube.deleteIfExists(TRAEFIK_INGRESS_ROUTES, signInResourceName(providerId));
    await this.kube.deleteIfExists(TRAEFIK_MIDDLEWARES, signInResourceName(providerId));
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
      throw new Error(`Cannot inherit app auth: source middleware ${appAuthMiddlewareName(fromRoutingId)} not found`);
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
      apiVersion: TRAEFIK_API_VERSION,
      kind: 'Middleware',
      metadata: { name: appAuthMiddlewareName(env.id), namespace: this.namespace },
      spec: { plugin: { [OIDC_PLUGIN]: clonedSpec } },
    };
    await this.writeGate(env, mw);
  }

  private async writeGate(env: AppAuthRouteTarget, oidcMiddleware: { metadata: { name: string } }): Promise<void> {
    await this.kube.upsert(TRAEFIK_MIDDLEWARES, oidcMiddleware.metadata.name, oidcMiddleware);
    await this.writeIdentityHeaderStrip();
    const ir = this.buildIngressRoute(env);
    await this.kube.upsert(TRAEFIK_INGRESS_ROUTES, ir.metadata.name, ir);
  }

  async writeIdentityHeaderStrip(): Promise<void> {
    const spec = {
      headers: { customRequestHeaders: Object.fromEntries(GATE_IDENTITY_HEADER_NAMES.map((name) => [name, ''])) },
    };
    const existing = (await this.kube.find(TRAEFIK_MIDDLEWARES, IDENTITY_STRIP_MIDDLEWARE)) as
      | { spec?: unknown }
      | undefined;
    if (isDeepStrictEqual(existing?.spec, spec)) return;
    await this.kube.upsert(TRAEFIK_MIDDLEWARES, IDENTITY_STRIP_MIDDLEWARE, {
      apiVersion: TRAEFIK_API_VERSION,
      kind: 'Middleware',
      metadata: { name: IDENTITY_STRIP_MIDDLEWARE, namespace: this.namespace },
      spec,
    });
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
      const route = (await this.kube.find(TRAEFIK_INGRESS_ROUTES, ingressRouteName(env.id))) as
        | TraefikIngressRoute
        | undefined;
      if (!route) return;
      const [{ services }] = route.spec.routes;
      const expectedRoutes = this.authRoutes(env, this.gateMiddlewares(env.id), services);
      if (isDeepStrictEqual(route.spec.routes, expectedRoutes)) return;
      try {
        await this.kube.replace(TRAEFIK_INGRESS_ROUTES, ingressRouteName(env.id), {
          ...route,
          spec: { ...route.spec, routes: expectedRoutes },
        });
        this.logger.log(`Rewrote the App Auth route of environment ${env.id}`);
        return;
      } catch (err) {
        if (!isConflict(err) || attempt === ROUTE_RECONCILE_ATTEMPTS) throw err;
      }
    }
  }

  async remove(routingId: string): Promise<void> {
    await this.kube.deleteIfExists(TRAEFIK_INGRESS_ROUTES, ingressRouteName(routingId));
    await this.kube.deleteIfExists(TRAEFIK_MIDDLEWARES, appAuthMiddlewareName(routingId));
  }

  async gatedRoutingIds(): Promise<string[]> {
    return (await this.kube.list(TRAEFIK_INGRESS_ROUTES))
      .map(({ metadata }) => metadata.name)
      .filter((name) => name.startsWith(APP_AUTH_ROUTE_PREFIX))
      .map((name) => name.slice(APP_AUTH_ROUTE_PREFIX.length));
  }
}
