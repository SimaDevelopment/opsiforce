import { allowAll, defineService, route } from '@opsiforce/external-service-sdk';

import manifest from './service.json' with { type: 'json' };
import type { Manifest } from './service.types.ts';
import { address } from './src/address.ts';
import { webhook } from './src/webhook.ts';

export default defineService<Manifest>({
  manifest,
  routes: [
    route<Manifest>('GET /address', {
      summary: "This Project environment's receiving address",
      allowedBy: [],
      check: allowAll,
      handle: address,
    }),
  ],
  webhook,
});
