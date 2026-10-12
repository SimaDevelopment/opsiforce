import { defineHandlers } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';
import { routeOperations } from './src/operations/routes.ts';

export default defineHandlers<Manifest>({ manifestHash, operations: routeOperations });
