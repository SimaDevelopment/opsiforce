import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { problem } from '@opsiforce/external-service-sdk';
import type { FastifyReply } from 'fastify';
import { sendProblem } from '../http/problem-reply';

export type CustomServiceRefusalCode =
  | 'invalid-name'
  | 'invalid-slug'
  | 'slug-taken'
  | 'slug-locked'
  | 'slug-mismatch'
  | 'invalid-environment'
  | 'check-failed'
  | 'not-published'
  | 'service-busy'
  | 'nothing-committed';

export class CustomServiceRefusal extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: CustomServiceRefusalCode,
    readonly detail: string,
    readonly extensions: Record<string, unknown> = {}
  ) {
    super(detail);
  }
}

@Catch(CustomServiceRefusal)
export class CustomServiceRefusalFilter implements ExceptionFilter<CustomServiceRefusal> {
  catch(refusal: CustomServiceRefusal, host: ArgumentsHost): void {
    void sendProblem(
      host.switchToHttp().getResponse<FastifyReply>(),
      problem({
        ...refusal.extensions,
        status: refusal.status,
        code: refusal.code,
        detail: refusal.detail,
        message: refusal.detail,
      })
    );
  }
}
