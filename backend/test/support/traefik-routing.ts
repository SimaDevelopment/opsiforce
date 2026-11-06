import type { AppAuthRouteRule } from '../../src/project/app-auth-route';

function traefikRoutingHost(requestHost: string): string {
  const host = requestHost.toLowerCase();
  const parts = host.split(':');
  return parts.length === 2 ? parts[0] : host;
}

export function traefikRuleMatches(rule: AppAuthRouteRule, requestHost: string): boolean {
  const host = traefikRoutingHost(requestHost);
  const patterns = [...rule.match.matchAll(/HostRegexp\(`([^`]+)`\)/g)].map(([, pattern]) => new RegExp(pattern));
  const exactHosts = [...rule.match.matchAll(/\bHost\(`([^`]+)`\)/g)].map(([, exact]) => exact);
  return exactHosts.includes(host.replace(/\.$/, '')) || patterns.some((pattern) => pattern.test(host));
}

export function traefikRedirect(
  redirectRegex: { regex: string; replacement: string },
  requestUrl: string
): string | null {
  const regex = new RegExp(redirectRegex.regex);
  if (!regex.test(requestUrl)) return null;
  return requestUrl.replace(regex, redirectRegex.replacement.replace(/\$\{(\d+)\}/g, '$$$1'));
}
