import { appCanonicalHost, LEADING_UUID, legacyAppHostLabel } from '../common/app-host';
import { redirectTargetOf } from '../custom-domain/custom-domain-objects';
import type { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { ProjectStatus } from '../project/project.types';

const ENVIRONMENT_ID_LENGTH = 36;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SHORT_ID = /^[0-9a-f]{12,32}$/;
const STILL_IN_THE_WARM_POOL = new Set<ProjectStatus>([ProjectStatus.Pending, ProjectStatus.Claiming]);

type EnvironmentLookup = Pick<
  ProjectEnvironmentService,
  'findByIdOrNull' | 'findByShortIdOrNull' | 'findByRoutedDomainOrNull'
>;

export interface AppDomains {
  appsHostname: string;
  previewAppsHostname: string;
}

type AppHost = { previewedEnvironmentId: string } | { label: string };

export interface ResolvedAppAddress {
  env: ProjectEnvironmentContext;
  action: 'serve' | 'redirect';
  canonicalHost: string;
  previewed: boolean;
}

export async function resolveAppAddress(
  host: string,
  { appsHostname, previewAppsHostname }: AppDomains,
  environments: EnvironmentLookup
): Promise<ResolvedAppAddress | null> {
  const hostname = host.toLowerCase().replace(/:\d+$/, '');
  const appHost = parseAppHost(hostname, appsHostname, previewAppsHostname);
  if (!appHost) return customDomainAddress(hostname, environments);

  if ('previewedEnvironmentId' in appHost) {
    const env = answering(await environments.findByIdOrNull(appHost.previewedEnvironmentId));
    return env && { env, action: 'serve', canonicalHost: appCanonicalHost(env, appsHostname), previewed: true };
  }

  const { label } = appHost;
  const byId = answering(await environmentLeading(label, environments));
  if (byId) {
    const isLegacyLabel = label === byId.id || label === legacyAppHostLabel(byId.id, byId.environmentSlug);
    return {
      env: byId,
      action: isLegacyLabel ? 'serve' : 'redirect',
      canonicalHost: appCanonicalHost(byId, appsHostname),
      previewed: false,
    };
  }

  const env = answering(await environmentEndingIn(label, environments));
  if (!env) return null;
  const canonicalHost = appCanonicalHost(env, appsHostname);
  const action = `${label}.${appsHostname}` === canonicalHost ? 'serve' : 'redirect';
  return { env, action, canonicalHost, previewed: false };
}

async function customDomainAddress(
  hostname: string,
  environments: EnvironmentLookup
): Promise<ResolvedAppAddress | null> {
  const routed = await environments.findByRoutedDomainOrNull(hostname);
  const env = routed && answering(routed.env);
  if (!routed || !env) return null;
  const canonicalHost = redirectTargetOf(hostname, routed.domain, env.mainDomain) ?? hostname;
  return { env, action: canonicalHost === hostname ? 'serve' : 'redirect', canonicalHost, previewed: false };
}

function parseAppHost(hostname: string, appsHostname: string, previewAppsHostname: string): AppHost | null {
  const previewed = labelUnder(hostname, previewAppsHostname);
  if (previewed !== null && isEnvironmentId(previewed)) return { previewedEnvironmentId: previewed };
  const label = labelUnder(hostname, appsHostname);
  return label !== null && DNS_LABEL.test(label) ? { label } : null;
}

function labelUnder(hostname: string, domain: string): string | null {
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return label.includes('.') ? null : label;
}

async function environmentLeading(
  label: string,
  environments: EnvironmentLookup
): Promise<ProjectEnvironmentContext | null> {
  const leadingId = label.slice(0, ENVIRONMENT_ID_LENGTH);
  const startsWithId = isEnvironmentId(leadingId) && (label === leadingId || label[ENVIRONMENT_ID_LENGTH] === '-');
  return startsWithId ? environments.findByIdOrNull(leadingId) : null;
}

async function environmentEndingIn(
  label: string,
  environments: EnvironmentLookup
): Promise<ProjectEnvironmentContext | null> {
  const shortId = label.slice(label.lastIndexOf('-') + 1);
  return shortId !== label && SHORT_ID.test(shortId) ? environments.findByShortIdOrNull(shortId) : null;
}

function answering(env: ProjectEnvironmentContext | null): ProjectEnvironmentContext | null {
  return env && !STILL_IN_THE_WARM_POOL.has(env.status) ? env : null;
}

function isEnvironmentId(label: string): boolean {
  return label.length === ENVIRONMENT_ID_LENGTH && LEADING_UUID.test(label);
}
