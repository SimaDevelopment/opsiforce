import type { Permission } from './permission.constants';
import { mapGroupsToPermissions } from './sso-group-map';

const ROLE_PREFIX = 'role:opsiforce_';
const TENANT_PREFIX = 'role:opsiforce_tenant_name_';

export function parsePermissions(groupsHeader: string): string[] {
  const mapped = mapGroupsToPermissions(groupsHeader);
  if (mapped) return mapped;
  return groupsHeader
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g.startsWith(ROLE_PREFIX) && !g.startsWith(TENANT_PREFIX))
    .map((g) => g.replace(ROLE_PREFIX, ''));
}

export function hasPermission(groupsHeader: string, permission: Permission): boolean {
  return parsePermissions(groupsHeader).includes(permission);
}

export function getGroupsHeader(request: { headers: Record<string, string | string[] | undefined> }): string {
  return (request.headers['x-forwarded-groups'] as string) ?? '';
}

function readHeader(request: { headers: Record<string, string | string[] | undefined> }, name: string): string | null {
  const raw = request.headers[name];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return null;
}

export function getUserIdHeader(request: { headers: Record<string, string | string[] | undefined> }): string | null {
  return readHeader(request, 'x-forwarded-user');
}

export function getUsernameHeader(request: { headers: Record<string, string | string[] | undefined> }): string | null {
  return readHeader(request, 'x-forwarded-preferred-username');
}

export function getEmailHeader(request: { headers: Record<string, string | string[] | undefined> }): string | null {
  return readHeader(request, 'x-forwarded-email');
}
