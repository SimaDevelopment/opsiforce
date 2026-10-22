import type { ServerResponse } from 'node:http';
import {
  ChatCompletionTranslator,
  UnsupportedChatRequestError,
  chatCompletionOf,
  responsesRequestOf,
} from '../chat-completions.ts';
import type { ChatStreamStep } from '../chat-completions.ts';
import type { CallerAccess } from '../credentials.ts';
import { isRecord, sendError, sendJson } from '../http.ts';
import type { JsonRecord } from '../http.ts';
import { answerFailedOpening, openCodexStream } from './codex.ts';
import { SSE_HEADERS } from './forward.ts';
import { codexEventsOf, statusOfFailure } from './sse.ts';

async function* chatStepsOf(
  stream: ReadableStream<Uint8Array>,
  translator: ChatCompletionTranslator
): AsyncGenerator<ChatStreamStep> {
  for await (const event of codexEventsOf(stream)) {
    const step = translator.next(event);
    yield step;
    if (step.kind !== 'chunks') return;
  }
}

const chatEventOf = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

async function streamChatChunks(
  res: ServerResponse,
  stream: ReadableStream<Uint8Array>,
  translator: ChatCompletionTranslator
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  try {
    for await (const step of chatStepsOf(stream, translator)) {
      if (step.kind === 'failed') {
        res.end(chatEventOf({ error: step.error }));
        return;
      }
      for (const chunk of step.chunks) res.write(chatEventOf(chunk));
    }
  } catch {
    res.destroy();
    return;
  }
  res.end('data: [DONE]\n\n');
}

async function sendChatCompletion(
  res: ServerResponse,
  stream: ReadableStream<Uint8Array>,
  translator: ChatCompletionTranslator
): Promise<void> {
  const chunks: JsonRecord[] = [];
  for await (const step of chatStepsOf(stream, translator)) {
    if (step.kind === 'failed') {
      sendError(res, statusOfFailure([step.error.type, step.error.code]), step.error);
      return;
    }
    chunks.push(...step.chunks);
  }
  sendJson(res, 200, chatCompletionOf(chunks));
}

export async function forwardChatCompletionsToChatGpt(
  chat: JsonRecord,
  res: ServerResponse,
  access: CallerAccess
): Promise<void> {
  let body: JsonRecord;
  try {
    body = responsesRequestOf(chat);
  } catch (error: unknown) {
    if (!(error instanceof UnsupportedChatRequestError)) throw error;
    sendError(res, 400, { message: error.message, type: 'invalid_request_error' });
    return;
  }

  const opening = await openCodexStream(access, body);
  if (opening.kind !== 'output') {
    answerFailedOpening(res, opening);
    return;
  }
  const model = typeof chat.model === 'string' ? chat.model : '';
  if (chat.stream === true) {
    const includeUsage = isRecord(chat.stream_options) && chat.stream_options.include_usage === true;
    await streamChatChunks(res, opening.stream, new ChatCompletionTranslator(model, includeUsage));
    return;
  }
  await sendChatCompletion(res, opening.stream, new ChatCompletionTranslator(model, true));
}
