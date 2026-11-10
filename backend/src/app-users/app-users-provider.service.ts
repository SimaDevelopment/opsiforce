import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, lt } from 'drizzle-orm';
import { db } from '../../db';
import { appUserAuthorizationCodes, projectApps, projectEnvironments, projects } from '../../db/schema';
import { timingSafeStringEqual } from '../common/secret-crypto';
import { redirectTargetOf } from '../custom-domain/custom-domain-objects';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { callbackHostOf, isGatedHost } from '../project/app-auth-route';
import { appUsersAddresses, appUsersClientSecret } from './app-users-client';
import { signJwt, verifyJwt, type JwtClaims, type TokenUse } from './app-user-jwt';
import { AppUserSigningKey } from './app-user-signing-key';
import { AppUsersService } from './app-users.service';
import type { AppUserIdentity } from './app-users.types';

const TOKEN_TTL_SECONDS = 5 * 60;
const REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const CODE_TTL_MS = 60 * 1000;
const SUPPORTED_SCOPES = ['openid', 'profile', 'email'];

export interface AppUsersClient {
  environmentId: string;
  shortId: string;
  projectId: string;
  appName: string;
}

export interface AuthorizationRequest {
  client: AppUsersClient;
  redirectUri: string;
  state: string | undefined;
  scope: string;
  codeChallenge: string;
  forceSignIn: boolean;
}

export type AuthorizationRequestCheck =
  | { outcome: 'valid'; request: AuthorizationRequest }
  | { outcome: 'refused'; message: string }
  | { outcome: 'redirect'; location: string };

export class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly error: string,
    readonly description: string
  ) {
    super(description);
  }
}

export interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export type OAuthParams = Record<string, unknown>;

const param = (params: OAuthParams, name: string): string | undefined => {
  const value = params[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const profileClaims = (user: AppUserIdentity) => ({
  email: user.email,
  email_verified: true,
  name: user.name ?? undefined,
  roles: user.roles,
});

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

const withQuery = (base: string, values: Record<string, string | undefined>) => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
};

@Injectable()
export class AppUsersProviderService {
  readonly issuer: string;
  private readonly providerUrl: string;
  private readonly gateSecret: string;
  private readonly appsHostname: string;

  constructor(
    configService: ConfigService,
    private readonly signingKey: AppUserSigningKey,
    private readonly appUsers: AppUsersService,
    private readonly environments: ProjectEnvironmentService
  ) {
    const addresses = appUsersAddresses(configService);
    this.issuer = addresses?.issuer ?? '';
    this.providerUrl = addresses?.providerUrl ?? '';
    this.gateSecret = configService.get<string>('oidcPluginSecret') ?? '';
    this.appsHostname = configService.getOrThrow<string>('appsHostname');
  }

  get issuerPath(): string {
    return new URL(this.issuer).pathname;
  }

  discovery() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      end_session_endpoint: `${this.issuer}/logout`,
      token_endpoint: `${this.providerUrl}/token`,
      jwks_uri: `${this.providerUrl}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: SUPPORTED_SCOPES,
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'email', 'email_verified', 'name', 'roles'],
    };
  }

  async jwks() {
    return { keys: [(await this.signingKey.load()).jwk] };
  }

  async client(clientId: string | undefined): Promise<AppUsersClient | null> {
    if (!clientId) return null;
    const [row] = await db
      .select({
        environmentId: projectEnvironments.id,
        shortId: projectEnvironments.shortId,
        projectId: projectEnvironments.projectId,
        authMode: projectEnvironments.authMode,
        appName: projectApps.name,
        projectTitle: projects.title,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .leftJoin(projectApps, eq(projectApps.projectEnvironmentId, projectEnvironments.id))
      .where(eq(projectEnvironments.id, clientId));
    if (!row || row.authMode !== 'app_users') return null;
    return {
      environmentId: row.environmentId,
      shortId: row.shortId,
      projectId: row.projectId,
      appName: row.appName ?? row.projectTitle ?? 'this App',
    };
  }

  async checkAuthorizationRequest(params: OAuthParams): Promise<AuthorizationRequestCheck> {
    const client = await this.client(param(params, 'client_id'));
    if (!client) return { outcome: 'refused', message: 'This App does not sign visitors in with App Users.' };
    const redirectUri = param(params, 'redirect_uri');
    if (!redirectUri || !(await this.isCallbackOf(client, redirectUri))) {
      return { outcome: 'refused', message: 'This sign-in link does not belong to the App it names.' };
    }
    const state = param(params, 'state');
    const refuse = (error: string, description: string): AuthorizationRequestCheck => ({
      outcome: 'redirect',
      location: withQuery(redirectUri, { error, error_description: description, state }),
    });
    if (param(params, 'response_type') !== 'code') return refuse('unsupported_response_type', 'Only code is supported');
    const scopes = (param(params, 'scope') ?? '').split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) return refuse('invalid_scope', 'The openid scope is required');
    const codeChallenge = param(params, 'code_challenge');
    if (!codeChallenge || param(params, 'code_challenge_method') !== 'S256') {
      return refuse('invalid_request', 'PKCE with S256 is required');
    }
    return {
      outcome: 'valid',
      request: {
        client,
        redirectUri,
        state,
        scope: scopes.filter((scope) => SUPPORTED_SCOPES.includes(scope)).join(' '),
        codeChallenge,
        forceSignIn: param(params, 'prompt') === 'login',
      },
    };
  }

  async issueCode(request: AuthorizationRequest, user: AppUserIdentity): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const now = Date.now();
    await db.delete(appUserAuthorizationCodes).where(lt(appUserAuthorizationCodes.expiresAt, new Date(now)));
    await db.insert(appUserAuthorizationCodes).values({
      codeHash: hashCode(code),
      projectEnvironmentId: request.client.environmentId,
      appUserId: user.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      credentialsValidAfter: new Date(user.credentialsValidAfterMs),
      expiresAt: new Date(now + CODE_TTL_MS),
    });
    return withQuery(request.redirectUri, { code, state: request.state });
  }

  async session(projectId: string, cookie: string | undefined): Promise<AppUserIdentity | null> {
    if (!cookie) return null;
    const claims = await this.verify(cookie, this.issuer, 'session');
    if (!claims || claims.pid !== projectId) return null;
    return this.stillActive(projectId, claims);
  }

  async newSession(user: AppUserIdentity): Promise<{ value: string; maxAgeSeconds: number }> {
    const value = await this.sign(
      { sub: user.id, aud: this.issuer, pid: user.projectId, cva: user.credentialsValidAfterMs },
      'session',
      SESSION_TTL_SECONDS
    );
    return { value, maxAgeSeconds: SESSION_TTL_SECONDS };
  }

  async token(body: OAuthParams): Promise<TokenResponse> {
    const client = await this.authenticateClient(body);
    const grantType = param(body, 'grant_type');
    if (grantType === 'authorization_code') return this.exchangeCode(client, body);
    if (grantType === 'refresh_token') return this.refresh(client, body);
    throw new OAuthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  }

  async logoutTarget(params: OAuthParams): Promise<{ projectId: string | null; location: string | null }> {
    const client = await this.client(param(params, 'client_id'));
    if (!client) return { projectId: null, location: null };
    const target = param(params, 'post_logout_redirect_uri');
    const location =
      target && (await this.isCallbackOf(client, target)) ? withQuery(target, { state: param(params, 'state') }) : null;
    return { projectId: client.projectId, location };
  }

  private async isCallbackOf(client: AppUsersClient, url: string): Promise<boolean> {
    const host = callbackHostOf(url);
    if (host === null) return false;
    if (isGatedHost({ id: client.environmentId, shortId: client.shortId }, host, this.appsHostname)) return true;
    const routed = await this.environments.findByRoutedDomainOrNull(host);
    return (
      routed?.env.id === client.environmentId && redirectTargetOf(host, routed.domain, routed.env.mainDomain) === null
    );
  }

  private async authenticateClient(body: OAuthParams): Promise<AppUsersClient> {
    const clientSecret = param(body, 'client_secret');
    const client = await this.client(param(body, 'client_id'));
    const authenticated =
      client &&
      clientSecret &&
      this.gateSecret &&
      timingSafeStringEqual(appUsersClientSecret(this.gateSecret, client.environmentId), clientSecret);
    if (!authenticated) throw new OAuthError(401, 'invalid_client', 'Unknown client or wrong credentials');
    return client;
  }

  private async exchangeCode(client: AppUsersClient, body: OAuthParams): Promise<TokenResponse> {
    const code = param(body, 'code');
    const verifier = param(body, 'code_verifier');
    const [stored] = code
      ? await db
          .delete(appUserAuthorizationCodes)
          .where(eq(appUserAuthorizationCodes.codeHash, hashCode(code)))
          .returning()
      : [];
    const invalid = new OAuthError(400, 'invalid_grant', 'The code is invalid, used or expired');
    if (!stored || !verifier || stored.expiresAt.getTime() <= Date.now()) throw invalid;
    if (stored.projectEnvironmentId !== client.environmentId || stored.redirectUri !== param(body, 'redirect_uri')) {
      throw invalid;
    }
    if (createHash('sha256').update(verifier).digest('base64url') !== stored.codeChallenge) throw invalid;
    const user = await this.appUsers.activeUser(
      client.projectId,
      stored.appUserId,
      stored.credentialsValidAfter.getTime()
    );
    if (!user) throw invalid;
    return this.tokensFor(client, user, stored.scope);
  }

  private async refresh(client: AppUsersClient, body: OAuthParams): Promise<TokenResponse> {
    const invalid = new OAuthError(400, 'invalid_grant', 'The refresh token is invalid or revoked');
    const token = param(body, 'refresh_token');
    const claims = token ? await this.verify(token, this.issuer, 'refresh') : null;
    if (!claims || claims.cid !== client.environmentId) throw invalid;
    const user = await this.stillActive(client.projectId, claims);
    if (!user) throw invalid;
    return this.tokensFor(client, user, typeof claims.scope === 'string' ? claims.scope : 'openid');
  }

  private async tokensFor(client: AppUsersClient, user: AppUserIdentity, scope: string): Promise<TokenResponse> {
    const profile = profileClaims(user);
    const [idToken, accessToken, refreshToken] = await Promise.all([
      this.sign({ sub: user.id, aud: client.environmentId, ...profile }, 'id', TOKEN_TTL_SECONDS),
      this.sign({ sub: user.id, aud: client.environmentId, scope, roles: user.roles }, 'access', TOKEN_TTL_SECONDS),
      this.sign(
        { sub: user.id, aud: this.issuer, cid: client.environmentId, scope, cva: user.credentialsValidAfterMs },
        'refresh',
        REFRESH_TTL_SECONDS
      ),
    ]);
    return {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope,
    };
  }

  private async sign(
    claims: Record<string, unknown> & { sub: string; aud: string },
    use: TokenUse,
    ttlSeconds: number
  ): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    const full: JwtClaims = {
      ...claims,
      iss: this.issuer,
      iat,
      exp: iat + ttlSeconds,
      jti: randomBytes(12).toString('base64url'),
      token_use: use,
    };
    return signJwt(full, await this.signingKey.load());
  }

  private stillActive(projectId: string, claims: JwtClaims): Promise<AppUserIdentity | null> {
    return this.appUsers.activeUser(projectId, claims.sub, Number(claims.cva));
  }

  private async verify(token: string, audience: string, use: TokenUse): Promise<JwtClaims | null> {
    return verifyJwt(token, await this.signingKey.load(), { issuer: this.issuer, audience, use });
  }
}
