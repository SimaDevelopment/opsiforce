import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { api, ApiError } from './client';
import { createAppQuery } from '~/lib/create-app-query';

export type LimitKey = 'projects';

export interface LimitUsage {
  key: LimitKey;
  limit: number | null;
  used: number;
}

export interface TenantLimit extends LimitUsage {
  overridden: boolean;
}

export interface TenantLimits {
  tenantId: string;
  displayName: string;
  limits: TenantLimit[];
}

export interface PlatformLimitsView {
  platform: { key: LimitKey; value: number | null }[];
  tenants: TenantLimits[];
}

export const limitUsageKey = ['projects', 'limits'] as const;
const platformLimitsKey = ['platform-limits'] as const;

export function useLimitUsage() {
  return createAppQuery(() => ({
    queryKey: limitUsageKey,
    queryFn: () => api.get<LimitUsage[]>('/limits'),
  }));
}

export function useReachedLimit(key: LimitKey): () => number | null {
  const usage = useLimitUsage();
  return () => {
    const entry = usage.data?.find((item) => item.key === key);
    if (!entry || entry.limit === null || entry.used < entry.limit) return null;
    return entry.limit;
  };
}

export function limitRefusalMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.code === 'limit_reached' ? err.message : fallback;
}

export function usePlatformLimits() {
  return createAppQuery(() => ({
    queryKey: platformLimitsKey,
    queryFn: () => api.get<PlatformLimitsView>('/limits/platform'),
  }));
}

function useLimitsMutation<Vars>(request: (vars: Vars) => Promise<PlatformLimitsView>) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: request,
    onSuccess: (view: PlatformLimitsView) => {
      qc.setQueryData(platformLimitsKey, view);
      qc.invalidateQueries({ queryKey: limitUsageKey });
    },
  }));
}

export function useSetPlatformLimit() {
  return useLimitsMutation((vars: { key: LimitKey; value: number | null }) =>
    api.put<PlatformLimitsView>(`/limits/platform/${vars.key}`, { value: vars.value })
  );
}

export function useSetTenantLimit() {
  return useLimitsMutation((vars: { tenantId: string; key: LimitKey; value: number | null }) =>
    api.put<PlatformLimitsView>(`/limits/tenants/${vars.tenantId}/${vars.key}`, { value: vars.value })
  );
}

export function useFollowPlatformLimit() {
  return useLimitsMutation((vars: { tenantId: string; key: LimitKey }) =>
    api.delete<PlatformLimitsView>(`/limits/tenants/${vars.tenantId}/${vars.key}`)
  );
}
