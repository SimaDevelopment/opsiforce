import { SetMetadata } from '@nestjs/common';
import type { PublicApiCounter } from '../../external-services/built-ins/public-api-service';
import type { PublicApiSwitch } from '../../external-services/configuration/public-api-settings';

export const SERVICE_ROUTE_KEY = 'serviceRoute';

export interface ServiceRouteOptions {
  summary: string;
  allowedBy: readonly PublicApiSwitch[];
  counts?: PublicApiCounter;
}

export function ServiceRoute(options: ServiceRouteOptions): MethodDecorator {
  return SetMetadata(SERVICE_ROUTE_KEY, options);
}
