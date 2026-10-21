import { OpenCode, type OpenCodeEvent, type SessionPromptOutput } from '@opencode/client';
import type { Connection, Platform } from './platform.ts';

export function runtimeClient(platform: Platform, connection: Connection) {
  return OpenCode.make({
    baseUrl: platform.resolve(connection.baseUrl).href,
    fetch: (input, init) => platform.fetch(new Request(input, init)),
  });
}

export type RuntimeClient = ReturnType<typeof runtimeClient>;

export type TurnOutcome =
  | { readonly outcome: 'succeeded' }
  | { readonly outcome: 'failed'; readonly error: { readonly message: string } }
  | { readonly outcome: 'interrupted'; readonly reason: string };

export interface OwnPrompt {
  readonly sessionID: string;
  readonly id: string;
  readonly text: string;
}

export interface PromptForOutcomeOptions {
  readonly signal: AbortSignal;
  readonly admit?: (send: () => Promise<SessionPromptOutput>) => Promise<SessionPromptOutput>;
  readonly onEvent?: (event: OpenCodeEvent) => void;
}

export async function promptForOutcome(
  opencode: RuntimeClient,
  prompt: OwnPrompt,
  { signal, admit = (send) => send(), onEvent }: PromptForOutcomeOptions
): Promise<{ admitted: SessionPromptOutput; turn: TurnOutcome }> {
  const events = opencode.event.subscribe({ signal })[Symbol.asyncIterator]();
  try {
    const connected = await events.next();
    if (connected.done) throw closed(signal, 'The event stream closed before the prompt was sent');
    const admitted = await admit(() => opencode.session.prompt(prompt, { signal }));
    return { admitted, turn: await outcomeOf(events, prompt, signal, onEvent) };
  } finally {
    await events.return?.();
  }
}

async function outcomeOf(
  events: AsyncIterator<OpenCodeEvent>,
  prompt: OwnPrompt,
  signal: AbortSignal,
  onEvent: ((event: OpenCodeEvent) => void) | undefined
): Promise<TurnOutcome> {
  let delivered = false;
  for (;;) {
    const next = await events.next();
    if (next.done) throw closed(signal, 'The event stream closed before the turn ended');
    const event = next.value;
    if (!('sessionID' in event.data) || event.data.sessionID !== prompt.sessionID) continue;
    onEvent?.(event);
    if (event.type === 'session.inbox.delivered' && event.data.inboxID === prompt.id) delivered = true;
    if (!delivered) continue;
    if (event.type === 'session.execution.succeeded') return { outcome: 'succeeded' };
    if (event.type === 'session.execution.failed') return { outcome: 'failed', error: event.data.error };
    if (event.type === 'session.execution.interrupted') return { outcome: 'interrupted', reason: event.data.reason };
  }
}

function closed(signal: AbortSignal, message: string): unknown {
  return signal.aborted ? signal.reason : new Error(message);
}
