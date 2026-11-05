import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { api, type PodResources } from './client';
import { createAppQuery } from '~/lib/create-app-query';

export type PresetApplyMode = 'new' | 'all';

export interface PresetBounds {
  min: PodResources;
  max: PodResources;
}

export interface PresetUsage {
  projects: number;
  runningPods: number;
  /** Projects on the preset still running at other numbers than its current ones. */
  behind: number;
  behindRunningPods: number;
}

export interface PlatformPreset extends PresetUsage {
  id: string;
  name: string;
  resources: PodResources;
  isDefault: boolean;
}

export interface TenantPresetsSummary {
  tenantId: string;
  displayName: string;
  defaultPresetName: string | null;
  ownPresets: number;
  overrides: number;
}

export interface PlatformPresetsView {
  bounds: PresetBounds;
  presets: PlatformPreset[];
  tenants: TenantPresetsSummary[];
}

export interface OrganizationPreset extends PresetUsage {
  id: string;
  name: string;
  organization: boolean;
  resources: PodResources;
  platformResources: PodResources;
  overridden: boolean;
}

export interface OrganizationPresetsView {
  bounds: PresetBounds;
  presets: OrganizationPreset[];
  defaultPresetId: string | null;
  platformDefaultPresetId: string | null;
  ownDefault: boolean;
}

export interface PresetApplied {
  projects: number;
  restarting: number;
}

interface PresetSaveResult<View> {
  view: View;
  applied: PresetApplied;
}

/** Where presets are edited: the platform, the caller's own Organization, or one Organization from the platform. */
export type PresetScope = { kind: 'platform' } | { kind: 'own' } | { kind: 'tenant'; tenantId: string };

function basePath(scope: PresetScope): string {
  if (scope.kind === 'platform') return '/resource-presets/platform';
  if (scope.kind === 'tenant') return `/resource-presets/tenants/${scope.tenantId}`;
  return '/resource-presets';
}

function scopeKey(scope: PresetScope) {
  return ['resource-presets', scope.kind === 'tenant' ? scope.tenantId : scope.kind] as const;
}

export function usePlatformPresets(enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: scopeKey({ kind: 'platform' }),
    queryFn: () => api.get<PlatformPresetsView>(basePath({ kind: 'platform' })),
    enabled: enabled(),
  }));
}

export function useOrganizationPresets(scope: () => PresetScope) {
  return createAppQuery(() => ({
    queryKey: scopeKey(scope()),
    queryFn: () => api.get<OrganizationPresetsView>(basePath(scope())),
  }));
}

export function usePresetMutation<Vars>(
  scope: () => PresetScope,
  request: (base: string, vars: Vars) => Promise<PresetSaveResult<unknown>>
) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: Vars) => request(basePath(scope()), vars),
    onSuccess: (result: PresetSaveResult<unknown>) => {
      qc.setQueryData(scopeKey(scope()), result.view);
      void qc.invalidateQueries({ queryKey: ['resource-presets'] });
      void qc.invalidateQueries({ queryKey: ['pod-classes'] });
    },
  }));
}

export interface PresetDraftValues {
  name?: string;
  resources?: PodResources;
}

export function useCreatePreset(scope: () => PresetScope) {
  return usePresetMutation(scope, (base, vars: { name: string; resources: PodResources }) =>
    api.post<PresetSaveResult<unknown>>(base, vars)
  );
}

export function useUpdatePreset(scope: () => PresetScope) {
  return usePresetMutation(scope, (base, vars: PresetDraftValues & { id: string; apply: PresetApplyMode }) =>
    api.patch<PresetSaveResult<unknown>>(`${base}/${vars.id}`, {
      name: vars.name,
      resources: vars.resources,
      apply: vars.apply,
    })
  );
}

export function useDeletePreset(scope: () => PresetScope) {
  return usePresetMutation(scope, (base, id: string) => api.delete<PresetSaveResult<unknown>>(`${base}/${id}`));
}

export function useApplyPreset(scope: () => PresetScope) {
  return usePresetMutation(scope, (base, id: string) => api.post<PresetSaveResult<unknown>>(`${base}/${id}/apply`));
}

export function useRemoveOverride(scope: () => PresetScope) {
  return usePresetMutation(scope, (base, vars: { id: string; apply: PresetApplyMode }) =>
    api.delete<PresetSaveResult<unknown>>(`${base}/${vars.id}/override?apply=${vars.apply}`)
  );
}

export function useSetDefaultPreset(scope: () => PresetScope) {
  return usePresetMutation(scope, (base, presetId: string | null) =>
    api.put<PresetSaveResult<unknown>>(`${base}/default`, { presetId })
  );
}
