import type { FastifyReply } from 'fastify';

export const problemMediaType = 'application/problem+json';

export const PROBLEM_CONTENT_TYPE = `${problemMediaType}; charset=utf-8`;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  [extension: string]: unknown;
}

function problemTitle(code: string): string {
  const words = code.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function problem(
  fields: { status: number; code: string; title?: string; detail?: string } & Record<string, unknown>
): ProblemDetails {
  const { status, code, title, detail, ...extensions } = fields;
  return {
    type: `urn:opsiforce:error:${code}`,
    title: title ?? problemTitle(code),
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...extensions,
  };
}

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
