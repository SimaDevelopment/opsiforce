import type { Permission } from './permission.constants';
import { getGroupsHeader, hasPermission } from './permission.utils';

export function requirePermissionHook(routePrefix: string, permission: Permission) {
  return async (
    request: { url: string; headers: Record<string, string | string[] | undefined> },
    reply: { code(statusCode: number): { send(payload: unknown): void } }
  ) => {
    if (!request.url.startsWith(routePrefix)) return;
    if (!hasPermission(getGroupsHeader(request), permission)) {
      return reply.code(403).send({ message: 'Forbidden' });
    }
  };
}
