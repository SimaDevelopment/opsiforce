import { upstream } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

export const api = upstream<Manifest>({
  name: 'api',
  api: 'The upstream API and its version, as its docs name them',
  url: 'https://api.example.com',
});
