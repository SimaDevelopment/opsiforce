import { randomUUID } from 'node:crypto';
import { Perms } from '../../src/permission/permission.constants';
import { OPSIFORCE_TENANT_GROUP_PREFIX } from '../../src/tenant/tenant.service';
import { SERVICE_ACCOUNT_USERNAME_PREFIX } from '../../src/identity/forwarded-identity.service';
import { TENANT_NAME_HEADER } from '../../src/tenant/tenant.decorator';

const PERMISSION_GROUP_PREFIX = 'role:opsiforce_';

export interface ProxyIdentity {
  userId?: string;
  username?: string;
  email?: string | null;
  organizations?: string[];
  permissions?: string[];
  organization?: string;
}

export function organizationName(label = 'org'): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

export function serviceAccountUsername(client = 'client'): string {
  return `${SERVICE_ACCOUNT_USERNAME_PREFIX}${client}-${randomUUID().slice(0, 8)}`;
}

export function proxyHeaders(identity: ProxyIdentity = {}): Record<string, string> {
  const {
    userId = randomUUID(),
    username = `user-${userId.slice(0, 8)}`,
    email = `${username}@example.test`,
    organizations = [],
    permissions = [Perms.usePublicApi],
    organization,
  } = identity;

  const groups = [
    ...organizations.map((name) => `${OPSIFORCE_TENANT_GROUP_PREFIX}${name}`),
    ...permissions.map((permission) => `${PERMISSION_GROUP_PREFIX}${permission}`),
  ];

  return {
    'x-forwarded-user': userId,
    'x-forwarded-preferred-username': username,
    ...(email === null ? {} : { 'x-forwarded-email': email }),
    'x-forwarded-groups': groups.join(','),
    ...(organization === undefined ? {} : { [TENANT_NAME_HEADER]: organization }),
  };
}
