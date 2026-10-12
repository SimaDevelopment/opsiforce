import { readFileSync } from 'node:fs';

import type { OpenApiRoutes, OperationContext, ServiceHandlers } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../../service.types.ts';
import { callPublicApi } from '../client.ts';

const routes = JSON.parse(readFileSync(new URL('../../openapi-routes.json', import.meta.url), 'utf8')) as OpenApiRoutes;

export const routeOperations = Object.fromEntries(
  Object.keys(routes).map((operation) => [
    operation,
    (input: Record<string, unknown>, ctx: OperationContext<Manifest>) => callPublicApi(routes[operation], input, ctx),
  ])
) as unknown as ServiceHandlers<Manifest>['operations'];
