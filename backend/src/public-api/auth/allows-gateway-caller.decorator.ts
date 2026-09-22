import { SetMetadata } from '@nestjs/common';

export const ALLOWS_GATEWAY_CALLER_KEY = 'allowsGatewayCaller';

export const AllowsGatewayCaller = () => SetMetadata(ALLOWS_GATEWAY_CALLER_KEY, true);
