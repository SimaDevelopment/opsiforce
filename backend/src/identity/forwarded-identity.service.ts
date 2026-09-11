import { Injectable } from '@nestjs/common';
import { getEmailHeader, getGroupsHeader, getUserIdHeader, getUsernameHeader } from '../permission/permission.utils';
import { UserService } from '../user/user.service';

export const SERVICE_ACCOUNT_USERNAME_PREFIX = 'service-account-';

export type IdentityKind = 'user' | 'service-account';

export interface ForwardedHeaders {
  headers: Record<string, string | string[] | undefined>;
}

export interface ForwardedIdentity {
  keycloakId: string;
  username: string;
  profileName?: string;
  email: string | null;
  groups: string;
  kind: IdentityKind;
}

export interface PlatformIdentity extends ForwardedIdentity {
  platformId: string;
  platformEmail: string | null;
  displayName: string;
}

export function identityKind(username: string): IdentityKind {
  return username.startsWith(SERVICE_ACCOUNT_USERNAME_PREFIX) ? 'service-account' : 'user';
}

@Injectable()
export class ForwardedIdentityService {
  constructor(private readonly users: UserService) {}

  read(request: ForwardedHeaders): ForwardedIdentity | null {
    const keycloakId = getUserIdHeader(request);
    if (!keycloakId) return null;

    const email = getEmailHeader(request);
    const username = getUsernameHeader(request) ?? email ?? keycloakId;
    return {
      keycloakId,
      username,
      profileName: getUsernameHeader(request) ?? undefined,
      email,
      groups: getGroupsHeader(request),
      kind: identityKind(username),
    };
  }

  async resolve(identity: ForwardedIdentity, tenantId: string): Promise<PlatformIdentity> {
    const user = await this.users.getOrCreateUser(
      {
        keycloakId: identity.keycloakId,
        email: identity.email ?? undefined,
        displayName: identity.profileName,
      },
      tenantId,
      { skipPrivateWorkspace: identity.kind === 'service-account' }
    );

    return {
      ...identity,
      platformId: user.id,
      platformEmail: user.email,
      displayName: user.displayName ?? identity.username,
    };
  }
}
