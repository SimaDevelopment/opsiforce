import { Boxes, Database } from '~/components/icons';
import type { HasPermission } from '~/constants/permissions';
import { firstPermittedRailTab, railTabForPath, type RailTab } from '~/constants/section-rail';

export const ADMIN_GROUP_ORDER = ['Operations'] as const;

export const ADMIN_TABS: RailTab[] = [
  {
    to: '/admin/pods',
    label: 'Pods',
    description: 'Running environment pods and their live keep-alive activity.',
    group: 'Operations',
    icon: Boxes,
    isPermitted: (has) => has('can_view_pods'),
  },
  {
    to: '/admin/storage',
    label: 'Storage',
    description: 'Disk usage on the shared storage volume, across all organizations.',
    group: 'Operations',
    icon: Database,
    isPermitted: (has) => has('can_view_platform_storage'),
  },
];

export function firstPermittedAdminTab(hasPermission: HasPermission): RailTab | undefined {
  return firstPermittedRailTab(ADMIN_TABS, hasPermission);
}

export function adminTabForPath(pathname: string): RailTab | undefined {
  return railTabForPath(ADMIN_TABS, pathname);
}
