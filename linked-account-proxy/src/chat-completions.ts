import { isRecord } from './http.ts';
import type { ErrorBody, JsonRecord } from './http.ts';

export class UnsupportedChatRequestError extends Error {}

const PASSED_THROUGH_FIELDS = ['model', 'parallel_tool_calls', 'service_tier', 'prompt_cache_key'];

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

function inputPartOf(part: unknown): JsonRecord {
  if (!isRecord(part)) throw new UnsupportedChatRequestError('Every message content part must be an object.');
  if (part.type === 'text') return { type: 'input_text', text: typeof part.text === 'string' ? part.text : '' };
  if (part.type === 'image_url') {
    const image = isRecord(part.image_url) ? part.image_url : { url: part.image_url };
    if (typeof image.url !== 'string') throw new UnsupportedChatRequestError('An image_url part needs a url.');
    return {
      type: 'input_image',
      image_url: image.url,
      detail: typeof image.detail === 'string' ? image.detail : 'auto',
    };
  }
  if (part.type === 'file' && isRecord(part.file)) {
    const { file_data, file_id, filename } = part.file;
    return {
      type: 'input_file',
      ...(file_data ? { file_data } : {}),
      ...(file_id ? { file_id } : {}),
      ...(filename ? { filename } : {}),
    };
  }
  throw new UnsupportedChatRequestError(`Message content parts of type ${String(part.type)} are not supported.`);
}

function inputContentOf(content: unknown, role: string): string | JsonRecord[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(inputPartOf);
  throw new UnsupportedChatRequestError(`A ${role} message needs string or array content.`);
}

function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string';
}

function systemTextOf(content: unknown): { text: string; textOnly: boolean } {
  if (typeof content === 'string') return { text: content, textOnly: true };
  if (!Array.isArray(content)) return { text: '', textOnly: false };
  const textParts = content.filter(isTextPart);
  return { text: textParts.map((part) => part.text).join(''), textOnly: textParts.length === content.length };
}

function functionCallOf(toolCall: unknown): JsonRecord {
  if (!isRecord(toolCall) || !isRecord(toolCall.function) || typeof toolCall.id !== 'string') {
    throw new UnsupportedChatRequestError('An assistant tool call needs an id and a function.');
  }
  return {
    type: 'function_call',
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : '{}',
  };
}

function inputItemsOf(message: JsonRecord): JsonRecord[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: inputContentOf(message.content, 'user') }];
    case 'assistant': {
      const text = textOf(message.content);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(functionCallOf) : [];
      return [...(text ? [{ role: 'assistant', content: text }] : []), ...toolCalls];
    }
    case 'tool':
      if (typeof message.tool_call_id !== 'string')
        throw new UnsupportedChatRequestError('A tool message needs a tool_call_id.');
      return [
        { type: 'function_call_output', call_id: message.tool_call_id, output: textOf(message.content) || '(empty)' },
      ];
    case 'developer':
      return [{ role: 'developer', content: inputContentOf(message.content, 'developer') }];
    default:
      throw new UnsupportedChatRequestError(`Messages with role ${String(message.role)} are not supported.`);
  }
}

function conversationOf(messages: unknown, keepSystemInInput: boolean): { instructions: string; input: JsonRecord[] } {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new UnsupportedChatRequestError('messages must be a non-empty array.');
  }
  const systemTexts: string[] = [];
  const input: JsonRecord[] = [];
  for (const message of messages) {
    if (!isRecord(message)) throw new UnsupportedChatRequestError('Every message must be an object.');
    if (message.role !== 'system') {
      input.push(...inputItemsOf(message));
      continue;
    }
    const { text, textOnly } = systemTextOf(message.content);
    if (text) systemTexts.push(text);
    if (keepSystemInInput || !textOnly) {
      input.push({ role: 'developer', content: inputContentOf(message.content, 'system') });
    }
  }
  return { instructions: systemTexts.join('\n\n'), input };
}

function functionToolOf(tool: unknown): JsonRecord {
  if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
    throw new UnsupportedChatRequestError('Only function tools are supported.');
  }
  const { name, description, parameters, strict } = tool.function;
  return {
    type: 'function',
    name,
    ...(description !== undefined ? { description } : {}),
    parameters: parameters ?? { type: 'object', properties: {} },
    strict: strict === true,
  };
}

function toolChoiceOf(choice: unknown): unknown {
  if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function)) {
    return { type: 'function', name: choice.function.name };
  }
  return choice;
}

function textFormatOf(responseFormat: unknown): JsonRecord | undefined {
  if (!isRecord(responseFormat)) return undefined;
  if (responseFormat.type === 'json_object') return { type: 'json_object' };
  if (responseFormat.type === 'json_schema' && isRecord(responseFormat.json_schema)) {
    return { type: 'json_schema', ...responseFormat.json_schema };
  }
  return undefined;
}

export function responsesRequestOf(chat: JsonRecord): JsonRecord {
  if (typeof chat.n === 'number' && chat.n > 1)
    throw new UnsupportedChatRequestError('Only one choice (n = 1) is supported.');
  const format = textFormatOf(chat.response_format);
  const { instructions, input } = conversationOf(chat.messages, format?.type === 'json_object');
  const request: JsonRecord = { instructions, input, store: false, stream: true };
  for (const field of PASSED_THROUGH_FIELDS) if (chat[field] !== undefined) request[field] = chat[field];
  if (Array.isArray(chat.tools) && chat.tools.length > 0) request.tools = chat.tools.map(functionToolOf);
  if (chat.tool_choice !== undefined) request.tool_choice = toolChoiceOf(chat.tool_choice);
  if (typeof chat.reasoning_effort === 'string') request.reasoning = { effort: chat.reasoning_effort };
  else if (isRecord(chat.reasoning)) request.reasoning = chat.reasoning;
  const verbosity = typeof chat.verbosity === 'string' ? chat.verbosity : undefined;
  if (format || verbosity) request.text = { ...(format ? { format } : {}), ...(verbosity ? { verbosity } : {}) };
  return request;
}

interface ToolCallProgress {
  index: number;
  argumentsSent: number;
}

export type ChatStreamStep =
  | { kind: 'chunks'; chunks: JsonRecord[] }
  | { kind: 'finished'; chunks: JsonRecord[] }
  | { kind: 'failed'; error: ErrorBody };

function usageOf(usage: unknown): JsonRecord | undefined {
  if (!isRecord(usage)) return undefined;
  const prompt = Number(usage.input_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? 0);
  const cached = isRecord(usage.input_tokens_details) ? Number(usage.input_tokens_details.cached_tokens ?? 0) : 0;
  const reasoning = isRecord(usage.output_tokens_details)
    ? Number(usage.output_tokens_details.reasoning_tokens ?? 0)
    : 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens ?? prompt + completion),
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

export class ChatCompletionTranslator {
  private id = `chatcmpl-${Date.now().toString(36)}`;
  private created = Math.floor(Date.now() / 1000);
  private model: string;
  private roleSent = false;
  private readonly toolCalls = new Map<string, ToolCallProgress>();
  private readonly includeUsage: boolean;

  constructor(model: string, includeUsage: boolean) {
    this.model = model;
    this.includeUsage = includeUsage;
  }

  private envelope(): JsonRecord {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model };
  }

  private chunk(delta: JsonRecord, finishReason: string | null = null): JsonRecord {
    const role = this.roleSent ? {} : { role: 'assistant' };
    this.roleSent = true;
    return {
      ...this.envelope(),
      choices: [{ index: 0, delta: { ...role, ...delta }, finish_reason: finishReason }],
    };
  }

  private noteResponse(response: unknown): void {
    if (!isRecord(response)) return;
    if (typeof response.id === 'string') this.id = `chatcmpl-${response.id}`;
    if (typeof response.created_at === 'number') this.created = response.created_at;
    if (typeof response.model === 'string' && response.model) this.model = response.model;
  }

  private toolCallStart(item: JsonRecord): JsonRecord[] {
    const key = String(item.id ?? item.call_id);
    if (this.toolCalls.has(key)) return [];
    const progress = { index: this.toolCalls.size, argumentsSent: 0 };
    this.toolCalls.set(key, progress);
    return [
      this.chunk({
        tool_calls: [
          { index: progress.index, id: item.call_id, type: 'function', function: { name: item.name, arguments: '' } },
        ],
      }),
    ];
  }

  private toolCallArguments(key: string, text: string): JsonRecord[] {
    const progress = this.toolCalls.get(key);
    if (!progress || !text) return [];
    progress.argumentsSent += text.length;
    return [this.chunk({ tool_calls: [{ index: progress.index, function: { arguments: text } }] })];
  }

  private finish(response: unknown): JsonRecord[] {
    this.noteResponse(response);
    const record = isRecord(response) ? response : {};
    const incomplete = isRecord(record.incomplete_details) ? record.incomplete_details.reason : undefined;
    const finishReason =
      incomplete === 'max_output_tokens'
        ? 'length'
        : incomplete === 'content_filter'
          ? 'content_filter'
          : this.toolCalls.size > 0
            ? 'tool_calls'
            : 'stop';
    const chunks = [this.chunk({}, finishReason)];
    const usage = usageOf(record.usage);
    if (this.includeUsage && usage) chunks.push({ ...this.envelope(), choices: [], usage });
    return chunks;
  }

  next(event: JsonRecord): ChatStreamStep {
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        this.noteResponse(event.response);
        return { kind: 'chunks', chunks: [] };
      case 'response.output_text.delta':
        return {
          kind: 'chunks',
          chunks: typeof event.delta === 'string' && event.delta ? [this.chunk({ content: event.delta })] : [],
        };
      case 'response.refusal.delta':
        return {
          kind: 'chunks',
          chunks: typeof event.delta === 'string' && event.delta ? [this.chunk({ refusal: event.delta })] : [],
        };
      case 'response.output_item.added':
        return {
          kind: 'chunks',
          chunks: isRecord(event.item) && event.item.type === 'function_call' ? this.toolCallStart(event.item) : [],
        };
      case 'response.function_call_arguments.delta':
        return {
          kind: 'chunks',
          chunks: this.toolCallArguments(String(event.item_id), typeof event.delta === 'string' ? event.delta : ''),
        };
      case 'response.output_item.done': {
        if (!isRecord(event.item) || event.item.type !== 'function_call') return { kind: 'chunks', chunks: [] };
        const key = String(event.item.id ?? event.item.call_id);
        const started = this.toolCallStart(event.item);
        const sent = this.toolCalls.get(key)?.argumentsSent ?? 0;
        const full = typeof event.item.arguments === 'string' ? event.item.arguments : '';
        return { kind: 'chunks', chunks: [...started, ...this.toolCallArguments(key, full.slice(sent))] };
      }
      case 'response.completed':
      case 'response.incomplete':
        return { kind: 'finished', chunks: this.finish(event.response) };
      case 'response.failed':
      case 'error': {
        const response = isRecord(event.response) ? event.response : {};
        const error = isRecord(response.error) ? response.error : isRecord(event.error) ? event.error : event;
        return {
          kind: 'failed',
          error: {
            message: typeof error.message === 'string' ? error.message : 'The upstream response failed.',
            type: typeof error.type === 'string' ? error.type : 'upstream_error',
            ...(typeof error.code === 'string' ? { code: error.code } : {}),
          },
        };
      }
      default:
        return { kind: 'chunks', chunks: [] };
    }
  }
}

interface MergedToolCall {
  id?: unknown;
  type: 'function';
  function: { name?: unknown; arguments: string };
}

export function chatCompletionOf(chunks: readonly JsonRecord[]): JsonRecord {
  let content = '';
  let refusal = '';
  let finishReason: unknown = 'stop';
  let usage: unknown;
  const toolCalls: MergedToolCall[] = [];
  for (const chunk of chunks) {
    if (isRecord(chunk.usage)) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.refusal === 'string') refusal += delta.refusal;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : []) {
      const index = Number(call.index);
      const merged = (toolCalls[index] ??= { type: 'function', function: { arguments: '' } });
      if (call.id !== undefined) merged.id = call.id;
      const fn = isRecord(call.function) ? call.function : {};
      if (fn.name !== undefined) merged.function.name = fn.name;
      if (typeof fn.arguments === 'string') merged.function.arguments += fn.arguments;
    }
  }
  const first = chunks[0] ?? {};
  return {
    id: first.id,
    object: 'chat.completion',
    created: first.created,
    model: first.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || (toolCalls.length > 0 ? null : ''),
          ...(refusal ? { refusal } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
