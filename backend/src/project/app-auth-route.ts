import { appCanonicalHost, legacyAppHosts, type AppAddress } from '../common/app-host';
import type { ProjectAuthMode } from './project.types';

export const OIDC_CALLBACK_PATH = '/oidc/callback';

const SHORT_ID_PATTERN_PRIORITY = 100;
const ENVIRONMENT_ID_PATTERN_PRIORITY = 101;

export type AppAuthRouteTarget = Pick<AppAddress, 'id' | 'shortId'>;

export interface AppAuthRouteRule {
  match: string;
  priority: number;
}

export function appAuthRouteRules(env: AppAuthRouteTarget, appsHostname: string): AppAuthRouteRule[] {
  const apps = escapeRegExp(appsHostname);
  const anyLabelEndingInShortId = `^[a-z0-9-]+-${escapeRegExp(env.shortId)}\\.${apps}$`;
  const environmentIdAndAnySuffix = `^${escapeRegExp(env.id)}(-[a-z0-9-]+)?\\.${apps}$`;
  return [
    { match: `HostRegexp(\`${anyLabelEndingInShortId}\`)`, priority: SHORT_ID_PATTERN_PRIORITY },
    { match: `HostRegexp(\`${environmentIdAndAnySuffix}\`)`, priority: ENVIRONMENT_ID_PATTERN_PRIORITY },
  ];
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
