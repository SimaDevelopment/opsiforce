import { route } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../../service.types.ts';
import { needs } from '../access.ts';
import { rest } from '../upstreams.ts';

export const routes = [
  route<Manifest>('PUT /api/v3/repos/:owner/:repo/pulls/:number/merge', {
    to: rest,
    summary: 'Merge a pull request',
    allowedBy: ['repositories'],
    check: (_request, ctx) => needs(ctx, `${ctx.params.owner}/${ctx.params.repo}`, 'write', 'Merging a pull request'),
  }),
];
