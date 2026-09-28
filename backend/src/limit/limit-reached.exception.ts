import { ConflictException } from '@nestjs/common';
import { LIMITS } from './limit-registry';
import type { LimitKey } from './limit.types';

export class LimitReachedException extends ConflictException {
  constructor(
    readonly key: LimitKey,
    readonly limit: number
  ) {
    super({
      code: 'limit_reached',
      message: `This organization has reached its limit of ${limit} ${LIMITS[key].noun}.`,
      key,
      limit,
    });
  }
}
