import { createMutation, useQueryClient, type QueryClient } from '@tanstack/solid-query';
import { createEffect, on } from 'solid-js';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import { environmentKeys } from './environments';
import { useTenantConfig } from './tenant-config';

export type CustomDomainStatus = 'waiting' | 'issuing' | 'connected' | 'failed';

export interface DnsRecord {
  type: 'CNAME' | 'ALIAS';
  name: string;
  host: string;
  value: string;
}

export interface CustomDomain {
  id: string;
  hostname: string;
  displayHostname: string;
  bare: boolean;
  status: CustomDomainStatus;
  isMain: boolean;
  redirectsToMain: boolean;
  dnsAnswer: string | null;
  failureReason: string | null;
  checkedAt: string | null;
  records: DnsRecord[];
  signInCallback: string | null;
}

export interface CustomDomains {
  items: CustomDomain[];
  defaultAddress: string;
  usage: { used: number; limit: number | null };
}

export interface EnvironmentRef {
  projectId: string;
  environmentId: string;
}

const SETTLING_POLL_MS = 10_000;
const SETTLING = new Set<CustomDomainStatus>(['waiting', 'issuing']);

export const customDomainKeys = {
  forEnvironment: (ref: EnvironmentRef) => ['custom-domains', ref.projectId, ref.environmentId] as const,
};

function domainsPath(ref: EnvironmentRef): string {
  return `/projects/${ref.projectId}/environments/${ref.environmentId}/domains`;
}

function invalidateDomains(qc: QueryClient, ref: EnvironmentRef) {
  qc.invalidateQueries({ queryKey: customDomainKeys.forEnvironment(ref) });
  qc.invalidateQueries({ queryKey: environmentKeys.forProject(ref.projectId) });
}

export function connectedMainDomain(domains: CustomDomain[]): CustomDomain | undefined {
  return domains.find((domain) => domain.isMain && domain.status === 'connected');
}

export function useCustomDomainsOffered() {
  const tenantConfig = useTenantConfig();
  return () => tenantConfig.data?.customDomainsEnabled === true;
}

export function useCustomDomains(
  ref: () => EnvironmentRef,
  options: { enabled: () => boolean; refreshes: () => boolean }
) {
  const qc = useQueryClient();
  const domains = createAppQuery(() => ({
    queryKey: customDomainKeys.forEnvironment(ref()),
    queryFn: () =>
      options.refreshes()
        ? api.post<CustomDomains>(`${domainsPath(ref())}/refresh`)
        : api.get<CustomDomains>(domainsPath(ref())),
    enabled: options.enabled(),
    refetchInterval: (query) =>
      query.state.data?.items.some((domain) => SETTLING.has(domain.status)) ? SETTLING_POLL_MS : false,
  }));
  createEffect(
    on(
      () => connectedMainDomain(domains.data?.items ?? [])?.hostname,
      () => qc.invalidateQueries({ queryKey: environmentKeys.forProject(ref().projectId) }),
      { defer: true }
    )
  );
  return domains;
}

export function useAddCustomDomain() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: EnvironmentRef & { hostname: string }) =>
      api.post<CustomDomain>(domainsPath(vars), { hostname: vars.hostname }),
    onSuccess: (_domain, vars) => invalidateDomains(qc, vars),
  }));
}

export function useCheckCustomDomain() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: EnvironmentRef & { domainId: string }) =>
      api.post<CustomDomain>(`${domainsPath(vars)}/${vars.domainId}/check`),
    onSuccess: (_domain, vars) => invalidateDomains(qc, vars),
  }));
}

export function useMakeMainCustomDomain() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: EnvironmentRef & { domainId: string }) =>
      api.post<CustomDomain>(`${domainsPath(vars)}/${vars.domainId}/main`),
    onSuccess: (_domain, vars) => invalidateDomains(qc, vars),
  }));
}

export function useSetCustomDomainRedirect() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: EnvironmentRef & { domainId: string; redirectsToMain: boolean }) =>
      api.patch<CustomDomain>(`${domainsPath(vars)}/${vars.domainId}`, { redirectsToMain: vars.redirectsToMain }),
    onSuccess: (_domain, vars) => invalidateDomains(qc, vars),
  }));
}

export function useRemoveCustomDomain() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: EnvironmentRef & { domainId: string }) =>
      api.delete<{ ok: true }>(`${domainsPath(vars)}/${vars.domainId}`),
    onSuccess: (_result, vars) => invalidateDomains(qc, vars),
  }));
}
