import { defineService } from '@opsiforce/external-service-sdk';

import manifest from './service.json' with { type: 'json' };
import type { Manifest } from './service.types.ts';

export default defineService<Manifest>({ manifest, routes: [] });
