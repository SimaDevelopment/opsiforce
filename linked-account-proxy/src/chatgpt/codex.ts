import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { CallerAccess, LinkedAccountCredential } from '../credentials.ts';
import { isRecord, sendError } from '../http.ts';
import type { JsonRecord } from '../http.ts';
import { CODEX_RESPONSES_URL, ORIGINATOR, USER_AGENT } from './config.ts';
import { TRANSIENT_FAILURE_MESSAGE, holdUntilOutput } from './sse.ts';
import type { HeldStream } from './sse.ts';

const FIELDS_CODEX_REFUSES = [
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'user',
  'metadata',
  'safety_identifier',
  'truncation',
  'stop_sequences',
  'stream_options',
  'prompt_cache_retention',
];

function toolNamesOf(tools: unknown): unknown[] {
  return Array.isArray(tools) ? tools.map((tool) => (isRecord(tool) ? (tool.name ?? tool.type) : tool)) : [];
}

function conversationCacheKeyOf(body: JsonRecord): string {
  const firstInput = Array.isArray(body.input) ? body.input[0] : body.input;
  const reasoning = isRecord(body.reasoning) ? body.reasoning.effort : undefined;
  const start = JSON.stringify([body.model, reasoning, body.instructions, toolNamesOf(body.tools), firstInput]);
  return `lap-${createHash('sha256').update(start).digest('hex').slice(0, 32)}`;
}

function normalizeCodexResponsesBody(body: JsonRecord): JsonRecord {
  const normalized: JsonRecord = { ...body };
  for (const field of FIELDS_CODEX_REFUSES) delete normalized[field];
  normalized.instructions = typeof normalized.instructions === 'string' ? normalized.instructions : '';
  if (normalized.store === undefined) normalized.store = false;
  normalized.stream = true;
  if (typeof normalized.prompt_cache_key !== 'string' || !normalized.prompt_cache_key) {
    normalized.prompt_cache_key = conversationCacheKeyOf(normalized);
  }
  return normalized;
}

function buildUpstreamHeaders(credential: LinkedAccountCredential, body: JsonRecord): Headers {
  const headers = new Headers();
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key) {
    headers.set('session-id', body.prompt_cache_key);
  }
  headers.set('content-type', 'application/json');
  headers.set('authorization', `Bearer ${credential.accessToken}`);
  if (credential.accountId) headers.set('chatgpt-account-id', credential.accountId);
  headers.set('openai-beta', 'responses=experimental');
  headers.set('originator', ORIGINATOR);
  headers.set('user-agent', USER_AGENT);
  return headers;
}

function callCodex(credential: LinkedAccountCredential, body: JsonRecord): Promise<Response> {
  const normalized = normalizeCodexResponsesBody(body);
  return fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: buildUpstreamHeaders(credential, normalized),
    body: JSON.stringify(normalized),
  });
}

async function callCodexRetryingOnceWhenUnauthorized(access: CallerAccess, body: JsonRecord): Promise<Response> {
  const first = await callCodex(access.credential, body);
  if (first.status !== 401) return first;
  let refreshed: LinkedAccountCredential;
  try {
    refreshed = await access.credentials.forceRefreshed();
  } catch {
    return first;
  }
  await first.body?.cancel();
  return callCodex(refreshed, body);
}

export type CodexOpening = HeldStream | { kind: 'upstream-error'; status: number; contentType: string; text: string };

export type FailedOpening = Exclude<CodexOpening, { kind: 'output' }>;

export async function openCodexStream(access: CallerAccess, body: JsonRecord): Promise<CodexOpening> {
  let upstream: Response;
  try {
    upstream = await callCodexRetryingOnceWhenUnauthorized(access, body);
  } catch {
    return {
      kind: 'failure',
      status: 502,
      error: { message: 'Failed to reach the Codex backend.', type: 'codex_upstream_unreachable' },
    };
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return {
      kind: 'upstream-error',
      status: upstream.status === 400 && TRANSIENT_FAILURE_MESSAGE.test(text) ? 502 : upstream.status,
      contentType: upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      text: text || JSON.stringify({ error: { message: 'The Codex request failed.', type: 'upstream_error' } }),
    };
  }
  if (!upstream.body) {
    return {
      kind: 'failure',
      status: 502,
      error: { message: 'The Codex stream ended before any result arrived.', type: 'empty_upstream' },
    };
  }
  return holdUntilOutput(upstream.body);
}

export function answerFailedOpening(res: ServerResponse, opening: FailedOpening): void {
  if (opening.kind === 'broken') {
    res.destroy();
    return;
  }
  if (opening.kind === 'failure') {
    sendError(res, opening.status, opening.error);
    return;
  }
  res.writeHead(opening.status, { 'content-type': opening.contentType });
  res.end(opening.text);
}
