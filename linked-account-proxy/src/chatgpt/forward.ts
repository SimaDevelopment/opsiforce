import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { CallerAccess } from '../credentials.ts';
import { isRecord, sendError, sendJson } from '../http.ts';
import type { JsonRecord } from '../http.ts';
import { answerFailedOpening, openCodexStream } from './codex.ts';
import { COMPLETION_EVENT_TYPES, FAILURE_EVENT_TYPES, STREAM_ENDED_EARLY, codexEventsOf, failureOf } from './sse.ts';
import type { StreamFailure } from './sse.ts';

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

function usesServerReplayState(body: JsonRecord): boolean {
  if (typeof body.previous_response_id === 'string') return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.some((item) => isRecord(item) && item.type === 'item_reference' && typeof item.id === 'string');
}

type BufferedResponse = { kind: 'response'; response: JsonRecord } | ({ kind: 'failure' } & StreamFailure);

async function bufferedResponseOf(stream: ReadableStream<Uint8Array>): Promise<BufferedResponse> {
  for await (const event of codexEventsOf(stream)) {
    if (FAILURE_EVENT_TYPES.has(event.type)) return { kind: 'failure', ...failureOf(event) };
    if (COMPLETION_EVENT_TYPES.has(event.type) && isRecord(event.response)) {
      return { kind: 'response', response: event.response };
    }
  }
  return { kind: 'failure', ...STREAM_ENDED_EARLY };
}

export async function forwardToChatGpt(body: JsonRecord, res: ServerResponse, access: CallerAccess): Promise<void> {
  if (usesServerReplayState(body)) {
    sendError(res, 400, {
      message: 'This proxy is stateless, so each request must include the full conversation again.',
      type: 'unsupported_replay_state',
    });
    return;
  }

  const opening = await openCodexStream(access, body);
  if (opening.kind !== 'output') {
    answerFailedOpening(res, opening);
    return;
  }
  if (body.stream !== true) {
    const buffered = await bufferedResponseOf(opening.stream);
    if (buffered.kind === 'failure') sendError(res, buffered.status, buffered.error);
    else sendJson(res, 200, buffered.response);
    return;
  }
  res.writeHead(200, SSE_HEADERS);
  const stream = Readable.fromWeb(opening.stream);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
