import type { ProblemDetails } from '@opsiforce/external-service-sdk';
import { problemMediaType } from '@opsiforce/external-service-sdk/platform';
import type { FastifyReply } from 'fastify';

export const PROBLEM_CONTENT_TYPE = `${problemMediaType}; charset=utf-8`;

export async function sendProblem(
  reply: FastifyReply,
  body: ProblemDetails,
  headers: Record<string, string> = {}
): Promise<void> {
  await reply
    .status(body.status)
    .headers(headers)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .send(JSON.stringify(body));
}
