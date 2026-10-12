import { defineHandlers } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

export default defineHandlers<Manifest>({
  manifestHash,
  operations: {},
});
