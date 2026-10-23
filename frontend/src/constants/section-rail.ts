import type { Component } from 'solid-js';
import type { HasPermission } from '~/constants/permissions';

export interface RailTab {
  to: string;
  label: string;
  description: string;
  group: string;
  icon: Component<{ class?: string }>;
  isPermitted: (hasPermission: HasPermission) => boolean;
}

export function firstPermittedRailTab(tabs: RailTab[], hasPermission: HasPermission): RailTab | undefined {
  return tabs.find((tab) => tab.isPermitted(hasPermission));
}

export function railTabForPath(tabs: RailTab[], pathname: string): RailTab | undefined {
  return tabs.find((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`));
}
