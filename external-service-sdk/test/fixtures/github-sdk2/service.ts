import { allowAll, defineService, route } from '@opsiforce/external-service-sdk';

import manifest from './service.json' with { type: 'json' };
import type { Manifest } from './service.types.ts';
import { routes as merge } from './src/groups/merge.ts';

export default defineService<Manifest>({
  manifest,
  routes: [
    route<Manifest>('GET /api/v3/meta', {
      summary: 'What gh asks a GitHub Enterprise host',
      allowedBy: [],
      check: allowAll,
      handle: () => Response.json({ verifiable_password_authentication: false }),
    }),
    route<Manifest>('* /api/v3/repos/:owner/:repo/actions/**', {
      summary: 'Workflows are not available through this service',
      allowedBy: [],
    }),
    ...merge,
  ],
});
