import type { Component } from 'solid-js';
import { FolderKanban, Gauge, Layers, SlidersHorizontal, Wallet, Waypoints } from '~/components/icons';
import type { HasPermission } from '~/constants/permissions';
import { PRIVATE_TABS } from '~/private-loader';

export type SettingsGroup = 'Access' | 'Configuration' | 'Billing';

export interface SettingsTab {
  to: string;
  label: string;
  description: string;
  group: SettingsGroup;
  icon: Component<{ class?: string }>;
  isPermitted: (hasPermission: HasPermission) => boolean;
}

export const SETTINGS_GROUP_ORDER: SettingsGroup[] = ['Access', 'Configuration', 'Billing'];

export const SETTINGS_TABS: SettingsTab[] = [
  {
    to: '/settings/workspaces',
    label: 'Workspaces',
    description: 'Group and share projects.',
    group: 'Access',
    icon: FolderKanban,
    isPermitted: (has) => has('can_manage_workspaces'),
  },
  {
    to: '/settings/environments',
    label: 'Environments',
    description: 'The publish targets every project can deploy to — Development, Production, and any you add.',
    group: 'Configuration',
    icon: Layers,
    isPermitted: (has) => has('can_manage_environments'),
  },
  ...PRIVATE_TABS,
  {
    to: '/settings/model-providers',
    label: 'Model providers',
    description: "Where this organization's model requests go, and how each format splits them.",
    group: 'Configuration',
    icon: Waypoints,
    isPermitted: (has) => has('can_manage_tenant_model_providers') || has('can_manage_platform_model_providers'),
  },
  {
    to: '/settings/defaults',
    label: 'Defaults',
    description: 'The starting timeouts and budgets new organizations and projects are created with.',
    group: 'Configuration',
    icon: SlidersHorizontal,
    isPermitted: (has) => has('can_manage_platform_defaults') || has('can_manage_tenant_defaults'),
  },
  {
    to: '/settings/limits',
    label: 'Limits',
    description: 'How much each organization may hold, set once for the platform and overridden per organization.',
    group: 'Configuration',
    icon: Gauge,
    isPermitted: (has) => has('can_manage_platform_limits'),
  },
  {
    to: '/settings/billing',
    label: 'Billing',
    description: "This organization's spend and budget.",
    group: 'Billing',
    icon: Wallet,
    isPermitted: (has) => has('can_manage_tenant_budget'),
  },
];

export function firstPermittedSettingsTab(hasPermission: HasPermission): SettingsTab | undefined {
  return SETTINGS_TABS.find((tab) => tab.isPermitted(hasPermission));
}

export function settingsTabForPath(pathname: string): SettingsTab | undefined {
  return SETTINGS_TABS.find((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`));
}
