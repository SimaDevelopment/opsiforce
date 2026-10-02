import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { sendError, sendJson } from '../http.ts';
import type { JsonRecord } from '../http.ts';
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

async function* iterateServerSentEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<{ event?: string; data?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const separator = /\r?\n\r?\n/;
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(separator);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        const event: { event?: string; data?: string } = {};
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event.event = line.slice(6).trim();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0) event.data = dataLines.join('\n');
        yield event;
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
    res.writeHead(upstream.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  if (!upstream.body) {
    sendError(res, 502, { message: 'The Codex stream ended before any result arrived.', type: 'empty_upstream' });
    return;
  }
  const completed = await collectCompletedResponseFromSse(upstream.body);
  sendJson(res, 200, completed);
}
