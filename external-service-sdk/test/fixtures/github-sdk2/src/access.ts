import type { RouteContext, Verdict } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

const levels = ['read', 'pull_request', 'write'] as const;

type Level = (typeof levels)[number];

const levelNames: Record<Level, string> = { read: 'read', pull_request: 'pull request', write: 'write' };

export function needs(ctx: RouteContext<Manifest>, repository: string, level: Level, what: string): Verdict {
  const given = ctx.projectConfiguration.repositories?.find((entry) => entry.repositoryId === repository);
  if (given && levels.indexOf(given.access ?? 'read') >= levels.indexOf(level)) return ctx.allow();
  return ctx.notAllowed({
    setting: 'repositories',
    message: `${what} needs ${levelNames[level]} on ${repository} in this Project's Repositories`,
  });
}
