import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { sendError, sendJson } from '../http.ts';
import type { ErrorBody, JsonRecord } from '../http.ts';
import type { CallerCredentials, LinkedAccountCredential } from '../credentials.ts';
import { CODEX_RESPONSES_URL, ORIGINATOR, USER_AGENT } from './config.ts';

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function usesServerReplayState(body: JsonRecord): boolean {
  if (typeof body.previous_response_id === 'string') return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.some((item) => isRecord(item) && item.type === 'item_reference' && typeof item.id === 'string');
}

function normalizeCodexResponsesBody(body: JsonRecord): JsonRecord {
  const normalized: JsonRecord = { ...body };
  normalized.instructions = typeof normalized.instructions === 'string' ? normalized.instructions : '';
  if (normalized.store === undefined) normalized.store = false;
  normalized.stream = true;
  delete normalized.max_output_tokens;
  return normalized;
}

function buildUpstreamHeaders(credential: LinkedAccountCredential): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('authorization', `Bearer ${credential.accessToken}`);
  if (credential.accountId) headers.set('chatgpt-account-id', credential.accountId);
  headers.set('openai-beta', 'responses=experimental');
  headers.set('originator', ORIGINATOR);
  headers.set('user-agent', USER_AGENT);
  return headers;
}

interface ServerSentEvent {
  event?: string;
  data?: string;
}

const EVENT_SEPARATOR = /\r?\n\r?\n/;

function parseEventBlock(block: string): ServerSentEvent {
  const event: ServerSentEvent = {};
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event.event = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length > 0) event.data = dataLines.join('\n');
  return event;
}

async function* iterateServerSentEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(EVENT_SEPARATOR);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        yield parseEventBlock(block);
      }
    }
    if (buffer.trim()) {
      const dataLines = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      yield { data: dataLines.join('\n') };
    }
  } finally {
    reader.releaseLock();
  }
}

async function collectCompletedResponseFromSse(stream: ReadableStream<Uint8Array>): Promise<JsonRecord> {
  let latestResponse: JsonRecord | undefined;
  let latestError: unknown;
  for await (const event of iterateServerSentEvents(stream)) {
    if (!event.data) continue;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isRecord(parsed)) continue;
      if (event.event === 'error') {
        latestError = parsed;
        continue;
      }
      if (isRecord(parsed.response)) latestResponse = parsed.response;
    } catch {
      continue;
    }
  }
  if (latestResponse) return latestResponse;
  throw new Error(
    `No completed response found in the Codex stream.${latestError ? ` Last error: ${JSON.stringify(latestError)}` : ''}`
  );
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

const PREAMBLE_EVENT_TYPES = new Set(['response.created', 'response.in_progress']);
const FAILURE_EVENT_TYPES = new Set(['error', 'response.failed']);
const RATE_LIMIT_SIGNALS = new Set([
  'rate_limit_exceeded',
  'rate_limit_error',
  'too_many_requests',
  'insufficient_quota',
  'usage_limit_reached',
]);
const SERVER_FAILURE_SIGNALS = new Set(['server_error', 'internal_error', 'overloaded_error', 'service_unavailable']);

interface StreamFailure {
  status: number;
  error: ErrorBody;
}

type StreamOpening = { kind: 'undecided' } | { kind: 'output' } | ({ kind: 'failure' } & StreamFailure);

function parsedData(event: ServerSentEvent): JsonRecord | undefined {
  if (!event.data) return undefined;
  try {
    const parsed: unknown = JSON.parse(event.data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorRecordOf(data: JsonRecord | undefined): JsonRecord {
  if (isRecord(data?.error)) return data.error;
  if (isRecord(data?.response) && isRecord(data.response.error)) return data.response.error;
  return data ?? {};
}

function statusOfFailure(signals: (string | undefined)[]): number {
  if (signals.some((signal) => signal !== undefined && RATE_LIMIT_SIGNALS.has(signal))) return 429;
  if (signals.some((signal) => signal !== undefined && SERVER_FAILURE_SIGNALS.has(signal))) return 502;
  return 400;
}

function failureOf(eventType: string, data: JsonRecord | undefined): StreamFailure {
  const record = errorRecordOf(data);
  const message = typeof record.message === 'string' ? record.message : 'The Codex stream failed before any output.';
  const type = typeof record.type === 'string' && record.type !== eventType ? record.type : 'upstream_error';
  const code = typeof record.code === 'string' ? record.code : undefined;
  return { status: statusOfFailure([type, code]), error: { message, type, ...(code ? { code } : {}) } };
}

function openingOf(text: string): StreamOpening {
  for (const block of text.split(EVENT_SEPARATOR).slice(0, -1)) {
    if (!block.trim()) continue;
    const event = parseEventBlock(block);
    const data = parsedData(event);
    const type = event.event ?? (typeof data?.type === 'string' ? data.type : '');
    if (PREAMBLE_EVENT_TYPES.has(type)) continue;
    if (FAILURE_EVENT_TYPES.has(type)) return { kind: 'failure', ...failureOf(type, data) };
    return { kind: 'output' };
  }
  return { kind: 'undecided' };
}

async function streamToCaller(res: ServerResponse, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const held: Uint8Array[] = [];
  let text = '';
  let opening: StreamOpening = { kind: 'undecided' };
  try {
    while (opening.kind === 'undecided') {
      const { value, done } = await reader.read();
      if (done) break;
      held.push(value);
      text += decoder.decode(value, { stream: true });
      opening = openingOf(text);
    }
  } catch {
    res.destroy();
    return;
  }

  if (opening.kind === 'failure') {
    await reader.cancel().catch(() => undefined);
    sendError(res, opening.status, opening.error);
    return;
  }

  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of held) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  res.writeHead(200, SSE_HEADERS);
  const stream = Readable.fromWeb(rest);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function callCodex(credential: LinkedAccountCredential, body: JsonRecord): Promise<Response> {
  return fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: buildUpstreamHeaders(credential),
    body: JSON.stringify(normalizeCodexResponsesBody(body)),
  });
}

async function callCodexRetryingOnceWhenUnauthorized(
  credentials: CallerCredentials,
  credential: LinkedAccountCredential,
  body: JsonRecord
): Promise<Response> {
  const first = await callCodex(credential, body);
  if (first.status !== 401) return first;
  let refreshed: LinkedAccountCredential;
  try {
    refreshed = await credentials.forceRefreshed();
  } catch {
    return first;
  }
  await first.body?.cancel();
  return callCodex(refreshed, body);
}

export async function forwardToChatGpt(
  body: JsonRecord,
  res: ServerResponse,
  credentials: CallerCredentials,
  credential: LinkedAccountCredential
): Promise<void> {
  if (usesServerReplayState(body)) {
    sendError(res, 400, {
      message: 'This proxy is stateless, so each request must include the full conversation again.',
      type: 'unsupported_replay_state',
    });
    return;
  }

  const wantsStream = body.stream === true;
  let upstream: Response;
  try {
    upstream = await callCodexRetryingOnceWhenUnauthorized(credentials, credential, body);
  } catch {
    sendError(res, 502, { message: 'Failed to reach the Codex backend.', type: 'codex_upstream_unreachable' });
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    });
    res.end(text || JSON.stringify({ error: { message: 'The Codex request failed.', type: 'upstream_error' } }));
    return;
  }

  if (wantsStream) {
    if (!upstream.body) {
      res.writeHead(200, SSE_HEADERS);
      res.end();
      return;
    }
    await streamToCaller(res, upstream.body);
    return;
  }

  if (!upstream.body) {
    sendError(res, 502, { message: 'The Codex stream ended before any result arrived.', type: 'empty_upstream' });
    return;
  }
  const completed = await collectCompletedResponseFromSse(upstream.body);
  sendJson(res, 200, completed);
}
