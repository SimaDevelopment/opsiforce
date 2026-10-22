import type { Logger } from '@nestjs/common';
import { failureMessages } from '@opsiforce/external-service-sdk/platform';
import { manifestHeader, reloadingRetryAfterSeconds } from '@opsiforce/external-service-sdk/server';
import type { RegisteredService } from '../registry/service-registry';
import { refuse } from './gate-refusals';
import type { ServiceResponse } from './service-dispatcher';

export function checkServiceAnswer(
  answer: { callId: string; service: RegisteredService; response: ServiceResponse },
  logger: Logger
): void {
  const { callId, service, response } = answer;
  const answeredHash = response.headers[manifestHeader];
  if (answeredHash === undefined) {
    logger.error(`External Service call ${callId}: "${service.slug}" answered without ${manifestHeader}`);
    refuse({ status: 502, code: 'service-failed', detail: failureMessages.failed(service.manifest.displayName) });
  }
  if (answeredHash !== service.manifestHash) {
    const mismatch = `External Service call ${callId}: "${service.slug}" answered with manifest ${answeredHash}, the platform uses ${service.manifestHash}`;
    if (service.home?.lane === 'development') logger.warn(mismatch);
    else logger.error(mismatch);
    refuse(
      {
        status: 503,
        code: 'service-reloading',
        detail: `${service.manifest.displayName} is updating to a new version. Try again in a moment.`,
        service: service.slug,
      },
      { 'retry-after': String(reloadingRetryAfterSeconds) }
    );
  }
}
