import type { PodClassBounds, PodResources } from '../pod/pod-classes';

export const RESOURCE_PRESET_RESTART_QUEUE = 'resource-preset-restart';

/** At most one preset restart starts per this interval, across every worker and Apply. */
export const RESTART_STAGGER_MS = 3_000;

export const PRESET_APPLY_MODES = ['new', 'all'] as const;

export type PresetApplyMode = (typeof PRESET_APPLY_MODES)[number];

export interface PresetRestartJobData {
  projectEnvironmentId: string;
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
  bounds: PodClassBounds;
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
  bounds: PodClassBounds;
  presets: OrganizationPreset[];
  defaultPresetId: string | null;
  platformDefaultPresetId: string | null;
  ownDefault: boolean;
}

export interface PresetApplied {
  projects: number;
  restarting: number;
}

export interface PresetSaveResult<View> {
  view: View;
  applied: PresetApplied;
}

export interface CreatePresetDto {
  name: string;
  resources: PodResources;
}

export interface UpdatePresetDto {
  name?: string;
  resources?: PodResources;
  apply?: PresetApplyMode;
}

export interface SetDefaultPresetDto {
  presetId: string | null;
}
