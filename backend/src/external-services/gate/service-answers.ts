import type { Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { failureMessages } from '@opsiforce/external-service-sdk/platform';
import { outcomeHeader } from '@opsiforce/external-service-sdk/server';
import { SecretUnreadableError } from '../../sealing/secret-sealer';
import { PROBLEM_CONTENT_TYPE, problem, type ProblemDetails } from '../http/problem-reply';
import type { RegisteredService } from '../registry/service-registry';
import { GateRefusal, refuse, refuseDispatchFailure } from './gate-refusals';
import { ServiceDispatchError, type ServiceResponse } from './service-dispatcher';

export interface GateAnswer {
  callId: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function problemAnswer(callId: string, body: ProblemDetails, headers: Record<string, string> = {}): GateAnswer {
  return {
    callId,
    status: body.status,
    headers: { ...headers, 'content-type': PROBLEM_CONTENT_TYPE },
    body: encoder.encode(JSON.stringify({ ...body, callId })),
  };
}

function answeredMessage(response: ServiceResponse): string | null {
  try {
    const body = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    return typeof body.message === 'string' && body.message.trim() !== '' ? body.message : null;
  } catch {
    return null;
  }
}

export function answeredProblem(
  service: Pick<RegisteredService, 'manifest'>,
  response: ServiceResponse
): { code: string; detail: string } {
  const outcome = response.headers[outcomeHeader];
  const fallback =
    outcome === 'not supported'
      ? failureMessages.formOutOfDate()
      : failureMessages.failed(service.manifest.displayName);
  if (outcome === undefined) return { code: 'service-failed', detail: fallback };
  const code = outcome === 'failed' ? 'service-failed' : outcome.replaceAll(' ', '-');
  return { code, detail: answeredMessage(response) ?? fallback };
}

export function openedOrRefused<T>(logger: Logger, callId: string, service: RegisteredService, open: () => T): T {
  try {
    return open();
  } catch (error) {
    if (!(error instanceof SecretUnreadableError)) throw error;
    logger.error(
      `External Service call ${callId} to "${service.slug}": the secret sealed for ${error.place} cannot be opened there`
    );
    refuse({
      status: 500,
      code: 'secret-unreadable',
      detail: `A stored secret of ${service.manifest.displayName} can't be read; save it again in its configuration.`,
      service: service.slug,
    });
  }
}

export async function dispatchedOrRefused(
  service: RegisteredService,
  dispatch: () => Promise<ServiceResponse>
): Promise<ServiceResponse> {
  try {
    return await dispatch();
  } catch (error) {
    if (!(error instanceof ServiceDispatchError)) throw error;
    refuseDispatchFailure(service.slug, error);
  }
}

export function platformFailed(logger: Logger, callId: string, error: unknown): ProblemDetails {
  logger.error(`External Service call ${callId} failed in the platform`, (error as Error).stack);
  return problem({ status: 500, code: 'platform-failed', detail: 'The platform failed while handling this call.' });
}

export async function answeredOrProblem(
  logger: Logger,
  callId: string,
  answer: () => Promise<GateAnswer>
): Promise<GateAnswer> {
  try {
    return await answer();
  } catch (error) {
    if (error instanceof GateRefusal) return problemAnswer(callId, error.refusal, error.headers);
    return problemAnswer(callId, platformFailed(logger, callId, error));
  }
}

export async function sendGateAnswer(reply: FastifyReply, answer: GateAnswer): Promise<void> {
  await reply.status(answer.status).headers(answer.headers).send(Buffer.from(answer.body));
}
