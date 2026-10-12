import type { Logger } from '@nestjs/common';
import { containsSentSecret } from '@opsiforce/external-service-sdk/platform';
import {
  manifestHeader,
  reloadingRetryAfterSeconds,
  type ServiceResponse,
} from '@opsiforce/external-service-sdk/server';
import type { RegisteredService } from '../registry/service-registry';
import { refuse } from './gate-refusals';

export interface ServiceAnswer {
  callId: string;
  service: RegisteredService;
  response: ServiceResponse;
  sentSecrets: readonly string[];
}

export function checkServiceAnswer(answer: ServiceAnswer, logger: Logger): void {
  const { callId, service, response } = answer;
  const answeredHash = response.headers[manifestHeader];
  if (answeredHash === undefined) {
    logger.error(`External Service call ${callId}: "${service.slug}" answered without ${manifestHeader}`);
    refuse({ status: 502, code: 'service-failed', detail: 'The service failed while handling this call.' });
  }
  if (answeredHash !== service.manifestHash) {
    const mismatch = `External Service call ${callId}: "${service.slug}" answered with manifest ${answeredHash}, the Gate uses ${service.manifestHash}`;
    if (service.home?.lane === 'development') logger.warn(mismatch);
    else logger.error(mismatch);
    refuse(
      {
        status: 503,
        code: 'service-reloading',
        detail: `"${service.slug}" is reloading a new version; retry shortly.`,
        service: service.slug,
      },
      { 'retry-after': String(reloadingRetryAfterSeconds) }
    );
  }
  if (containsSentSecret(response, answer.sentSecrets)) {
    logger.warn(`External Service call ${callId}: "${service.slug}" answered with a secret the Gate sent it`);
    refuse({
      status: 502,
      code: 'secret-in-response',
      detail: `"${service.slug}" answered with one of its own secrets, so the answer was withheld.`,
      service: service.slug,
    });
  }
}
