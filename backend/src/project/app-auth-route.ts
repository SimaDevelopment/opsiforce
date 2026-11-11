import { appCanonicalHost, legacyAppHosts, type AppAddress } from '../common/app-host';
import type { ProjectAuthMode } from './project.types';

export const OIDC_CALLBACK_PATH = '/oidc/callback';
export const APP_AUTH_ROUTE_PREFIX = 'opsiforce-project-';

export const appAuthMiddlewareName = (routingId: string) => `${APP_AUTH_ROUTE_PREFIX}${routingId}-oidc`;
export const IDENTITY_STRIP_MIDDLEWARE = 'opsiforce-strip-identity-headers';

const SHORT_ID_PATTERN_PRIORITY = 100;
const ENVIRONMENT_ID_PATTERN_PRIORITY = 101;

export type AppAuthRouteTarget = Pick<AppAddress, 'id' | 'shortId'>;

export interface AppAuthRouteRule {
  match: string;
  priority: number;
}

function gatedHostPatterns(env: AppAuthRouteTarget, appsHostname: string) {
  const apps = escapeRegExp(appsHostname);
  return {
    anyLabelEndingInShortId: `^[a-z0-9-]+-${escapeRegExp(env.shortId)}\\.${apps}$`,
    environmentIdAndAnySuffix: `^${escapeRegExp(env.id)}(-[a-z0-9-]+)?\\.${apps}$`,
  };
}

export function appAuthRouteRules(env: AppAuthRouteTarget, appsHostname: string): AppAuthRouteRule[] {
  const { anyLabelEndingInShortId, environmentIdAndAnySuffix } = gatedHostPatterns(env, appsHostname);
  return [
    { match: `HostRegexp(\`${anyLabelEndingInShortId}\`)`, priority: SHORT_ID_PATTERN_PRIORITY },
    { match: `HostRegexp(\`${environmentIdAndAnySuffix}\`)`, priority: ENVIRONMENT_ID_PATTERN_PRIORITY },
  ];
}

export function callbackHostOf(url: string): string | null {
  const host = URL.canParse(url) ? new URL(url).hostname : '';
  return host && url === `https://${host}${OIDC_CALLBACK_PATH}` ? host : null;
}

export function isGatedHost(env: AppAuthRouteTarget, host: string, appsHostname: string): boolean {
  return Object.values(gatedHostPatterns(env, appsHostname)).some((pattern) => new RegExp(pattern).test(host));
}

export function appSignInCallbackUrls(env: AppAddress, appsHostname: string): string[] {
  const servingHosts = new Set([
    appCanonicalHost(env, appsHostname),
    ...legacyAppHosts(env.id, env.environmentSlug, appsHostname),
  ]);
  return [...servingHosts].map((host) => `https://${host}${OIDC_CALLBACK_PATH}`);
}

export function signInCallbacksAreRegisteredOutside(authMode: ProjectAuthMode): boolean {
  return authMode === 'manual';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
