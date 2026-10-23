import { api } from './client';
import type { HasPermission } from '~/constants/permissions';
import { createAppQuery } from '~/lib/create-app-query';

export function usePermissions() {
  const query = createAppQuery(() => ({
    queryKey: ['permissions'],
    queryFn: () => api.get<string[]>('/permissions'),
  }));

  const hasPermission: HasPermission = (permission) => query.data?.includes(permission) ?? false;

  return { permissions: query, hasPermission };
}
