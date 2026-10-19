import { upstream } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

export const rest = upstream<Manifest>({
  name: 'rest',
  api: 'GitHub REST API (2022-11-28)',
  url: 'https://api.github.com',
  mount: '/api/v3',
  credentials: ({ serviceConfiguration }) => ({
    headers: { authorization: `Bearer ${serviceConfiguration.privateKey.reveal()}` },
  }),
});
