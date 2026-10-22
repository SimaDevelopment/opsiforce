import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { CallerAccess } from '../credentials.ts';
import { isRecord, sendError, sendJson } from '../http.ts';
import type { JsonRecord } from '../http.ts';
import { answerFailedOpening, openCodexStream } from './codex.ts';
import { codexEventsOf } from './sse.ts';

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

async function completedResponseOf(stream: ReadableStream<Uint8Array>): Promise<JsonRecord> {
  let latestResponse: JsonRecord | undefined;
  let latestError: unknown;
  for await (const event of codexEventsOf(stream)) {
    if (event.type === 'error') latestError = event;
    else if (isRecord(event.response)) latestResponse = event.response;
  }
  if (latestResponse) return latestResponse;
  throw new Error(
    `No completed response found in the Codex stream.${latestError ? ` Last error: ${JSON.stringify(latestError)}` : ''}`
  );
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
    sendJson(res, 200, await completedResponseOf(opening.stream));
    return;
  }
  res.writeHead(200, SSE_HEADERS);
  const stream = Readable.fromWeb(opening.stream);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
