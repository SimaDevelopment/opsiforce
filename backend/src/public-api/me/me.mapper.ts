import type { Caller } from '../auth/caller';
import type { MeDto } from './me.schema';

export const MeMapper = {
  toDto: (caller: Caller): MeDto => ({
    id: caller.user.platformId,
    username: caller.user.username,
    email: caller.user.email,
    displayName: caller.user.displayName,
    organization: caller.organization,
    organizations: caller.organizations,
    permissions: [...caller.permissions].toSorted(),
  }),
};
