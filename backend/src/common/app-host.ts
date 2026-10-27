export const LEADING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export interface AppAddress {
  id: string;
  environmentSlug: string | null;
  shortId: string;
  appSlug: string | null;
}

export function legacyAppHostLabel(routingId: string, environmentSlug: string | null | undefined): string {
  return environmentSlug ? `${routingId}-${environmentSlug}` : routingId;
}

export function legacyAppHost(
  routingId: string,
  environmentSlug: string | null | undefined,
  appsHostname: string
): string {
  return `${legacyAppHostLabel(routingId, environmentSlug)}.${appsHostname}`;
}

export function legacyAppHosts(routingId: string, environmentSlug: string | null, appsHostname: string): string[] {
  return [...new Set([environmentSlug, null].map((slug) => legacyAppHost(routingId, slug, appsHostname)))];
}

export function appCanonicalHost(env: AppAddress, appsHostname: string): string {
  if (!env.appSlug || !env.environmentSlug) return legacyAppHost(env.id, env.environmentSlug, appsHostname);
  return `${env.appSlug}-${env.environmentSlug}-${env.shortId}.${appsHostname}`;
}
