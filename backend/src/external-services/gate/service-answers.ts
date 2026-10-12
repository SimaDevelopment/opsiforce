import type { Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { problem, type ProblemDetails } from '@opsiforce/external-service-sdk';
import { forwardedAnswerHeaders, problemMediaType } from '@opsiforce/external-service-sdk/platform';
import type { ServiceResponse } from '@opsiforce/external-service-sdk/server';
import { SecretUnreadableError } from '../../sealing/secret-sealer';
import { PROBLEM_CONTENT_TYPE } from '../http/problem-reply';
import type { RegisteredService } from '../registry/service-registry';
import type { CallLog, CallRecord } from './call-log';
import { GateRefusal, refuse, refuseDispatchFailure } from './gate-refusals';
import { ServiceDispatchError } from './service-dispatcher';

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

export function forwardedAnswer(callId: string, response: ServiceResponse): GateAnswer {
  return {
    callId,
    status: response.status,
    headers: Object.fromEntries(
      forwardedAnswerHeaders.flatMap((name) => {
        const value = response.headers[name];
        return value === undefined ? [] : [[name, value]];
      })
    ),
    body: response.body,
  };
}

export function answeredProblem(response: ServiceResponse): { code: string | null; detail: string | null } {
  if (!response.headers['content-type']?.startsWith(problemMediaType)) return { code: null, detail: null };
  try {
    const body = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    return {
      code: typeof body.code === 'string' ? body.code : null,
      detail: typeof body.detail === 'string' ? body.detail : null,
    };
  } catch {
    return { code: null, detail: null };
  }
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
      detail: `A stored secret of "${service.slug}" cannot be read; save it again in its configuration.`,
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

function gateFailed(logger: Logger, callId: string, error: unknown): ProblemDetails {
  logger.error(`External Service call ${callId} failed in the Gate`, (error as Error).stack);
  return problem({ status: 500, code: 'gate-failed', detail: 'The platform failed while handling this call.' });
}

export interface CallAnswer<T> {
  answer: T;
  status: number;
  outputBytes?: number;
  unlogged?: boolean;
}

export interface LoggedAttempt<T> {
  answer: () => Promise<CallAnswer<T>>;
  refused: (refusal: ProblemDetails, headers: Record<string, string>, cause: GateRefusal | null) => CallAnswer<T>;
  failed: (error: unknown) => ProblemDetails;
}

export async function answeredAndLogged<T>(callLog: CallLog, call: CallRecord, attempt: LoggedAttempt<T>): Promise<T> {
  const started = performance.now();
  let answered: CallAnswer<T>;
  try {
    answered = await attempt.answer();
  } catch (error) {
    const cause = error instanceof GateRefusal ? error : null;
    const refusal = cause ? cause.refusal : attempt.failed(error);
    call.code = refusal.code;
    call.detail = refusal.detail ?? null;
    answered = attempt.refused(refusal, cause?.headers ?? {}, cause);
  }
  if (answered.unlogged) return answered.answer;
  call.status = answered.status;
  if (answered.outputBytes !== undefined) call.outputBytes = answered.outputBytes;
  call.durationMs = Math.round(performance.now() - started);
  await callLog.record(call);
  return answered.answer;
}

function withStatus(answered: GateAnswer): CallAnswer<GateAnswer> {
  return { answer: answered, status: answered.status };
}

export function answeredOrProblemAndLogged(
  logger: Logger,
  callLog: CallLog,
  call: CallRecord,
  answer: () => Promise<GateAnswer>
): Promise<GateAnswer> {
  return answeredAndLogged(callLog, call, {
    answer: async () => withStatus(await answer()),
    refused: (refusal, headers) => withStatus(problemAnswer(call.id, refusal, headers)),
    failed: (error) => gateFailed(logger, call.id, error),
  });
}

const answerSafetyHeaders = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
};

export async function sendGateAnswer(reply: FastifyReply, answer: GateAnswer): Promise<void> {
  await reply
    .status(answer.status)
    .headers({ ...answer.headers, ...answerSafetyHeaders })
    .send(Buffer.from(answer.body));
}
