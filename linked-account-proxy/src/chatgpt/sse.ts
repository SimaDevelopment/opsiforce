import { isRecord } from '../http.ts';
import type { ErrorBody, JsonRecord } from '../http.ts';

interface ServerSentEvent {
  event?: string;
  data?: string;
}

export type CodexEvent = JsonRecord & { type: string };

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

async function* serverSentEventsOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
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

function parsedData(event: ServerSentEvent): JsonRecord | undefined {
  if (!event.data) return undefined;
  try {
    const parsed: unknown = JSON.parse(event.data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function codexEventOf(event: ServerSentEvent): CodexEvent | undefined {
  const data = parsedData(event);
  if (!data) return undefined;
  return { ...data, type: event.event ?? (typeof data.type === 'string' ? data.type : '') };
}

export async function* codexEventsOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<CodexEvent> {
  for await (const event of serverSentEventsOf(stream)) {
    const codexEvent = codexEventOf(event);
    if (codexEvent) yield codexEvent;
  }
}

const PREAMBLE_EVENT_TYPES = new Set(['response.created', 'response.in_progress']);
export const FAILURE_EVENT_TYPES = new Set(['error', 'response.failed']);
export const COMPLETION_EVENT_TYPES = new Set(['response.completed', 'response.incomplete']);
const RATE_LIMIT_SIGNALS = new Set([
  'rate_limit_exceeded',
  'rate_limit_error',
  'too_many_requests',
  'insufficient_quota',
  'usage_limit_reached',
]);
const SERVER_FAILURE_SIGNALS = new Set([
  'server_error',
  'internal_error',
  'overloaded_error',
  'service_unavailable',
  'server_is_overloaded',
  'slow_down',
]);
export const TRANSIENT_FAILURE_MESSAGE = /at capacity|an error occurred while processing your request/i;

export interface StreamFailure {
  status: number;
  error: ErrorBody;
}

function errorRecordOf(data: JsonRecord): JsonRecord {
  if (isRecord(data.error)) return data.error;
  if (isRecord(data.response) && isRecord(data.response.error)) return data.response.error;
  return data;
}

export function statusOfFailure(signals: (string | undefined)[]): number {
  if (signals.some((signal) => signal !== undefined && RATE_LIMIT_SIGNALS.has(signal))) return 429;
  if (signals.some((signal) => signal !== undefined && SERVER_FAILURE_SIGNALS.has(signal))) return 502;
  return 400;
}

export function failureOf(event: CodexEvent): StreamFailure {
  const record = errorRecordOf(event);
  const message = typeof record.message === 'string' ? record.message : 'The Codex stream failed before any output.';
  const type = typeof record.type === 'string' && record.type !== event.type ? record.type : 'upstream_error';
  const code = typeof record.code === 'string' ? record.code : undefined;
  const status = TRANSIENT_FAILURE_MESSAGE.test(message) ? 502 : statusOfFailure([type, code]);
  return { status, error: { message, type, ...(code ? { code } : {}) } };
}

function isEmptyCompletion(event: CodexEvent): boolean {
  const response = isRecord(event.response) ? event.response : {};
  const output = Array.isArray(response.output) ? response.output : [];
  return output.length === 0 && !isRecord(response.usage);
}

const EMPTY_COMPLETION: StreamFailure = {
  status: 502,
  error: { message: 'ChatGPT completed the response without any output.', type: 'empty_upstream_response' },
};

export const STREAM_ENDED_EARLY: StreamFailure = {
  status: 502,
  error: {
    message: 'ChatGPT ended the stream before the response completed.',
    type: 'server_error',
    code: 'stream_incomplete',
  },
};

type StreamOpening = { kind: 'undecided' } | { kind: 'output' } | ({ kind: 'failure' } & StreamFailure);

function openingOf(text: string): StreamOpening {
  for (const block of text.split(EVENT_SEPARATOR).slice(0, -1)) {
    const parsed = parseEventBlock(block);
    if (parsed.data === undefined) continue;
    const event = codexEventOf(parsed) ?? { type: parsed.event ?? '' };
    if (PREAMBLE_EVENT_TYPES.has(event.type)) continue;
    if (FAILURE_EVENT_TYPES.has(event.type)) return { kind: 'failure', ...failureOf(event) };
    if (event.type === 'response.completed' && isEmptyCompletion(event))
      return { kind: 'failure', ...EMPTY_COMPLETION };
    return { kind: 'output' };
  }
  return { kind: 'undecided' };
}

export type HeldStream =
  | { kind: 'output'; stream: ReadableStream<Uint8Array> }
  | ({ kind: 'failure' } & StreamFailure)
  | { kind: 'broken' };

export async function holdUntilOutput(body: ReadableStream<Uint8Array>): Promise<HeldStream> {
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
    return { kind: 'broken' };
  }

  if (opening.kind === 'undecided') opening = openingOf(`${text}\n\n`);
  if (opening.kind === 'undecided') return { kind: 'failure', ...STREAM_ENDED_EARLY };
  if (opening.kind === 'failure') {
    await reader.cancel().catch(() => undefined);
    return opening;
  }

  const stream = new ReadableStream<Uint8Array>({
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
  return { kind: 'output', stream };
}
