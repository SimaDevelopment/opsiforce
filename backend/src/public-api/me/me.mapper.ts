import type { BuilderSubject } from '../../builder/builder.types';
import type { Caller } from '../auth/caller';
import type { MeDto } from './me.schema';

export const MeMapper = {
  toDto: (caller: Caller, builderSubject: BuilderSubject | null): MeDto => ({
    id: caller.user.platformId,
    username: caller.user.username,
    email: caller.user.email,
    displayName: caller.user.displayName,
    source: caller.source,
    organization: caller.organization,
    organizations: caller.organizations,
    permissions: [...caller.permissions].toSorted(),
    builderSubject,
  }),
};
