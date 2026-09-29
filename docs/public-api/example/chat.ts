import { Platform, sleep, type JsonValue } from './platform.ts';
import { runtimeClient } from './runtime.ts';

interface Agent {
  id: string;
  name: string;
}

interface Environment {
  id: string;
  isDefault: boolean;
  status: string;
  opencode: { baseUrl: string; openapiUrl: string; sessionId: string | null };
}

interface Project {
  id: string;
  title: string | null;
  environments: Environment[];
}

const origin = required('OPSIFORCE_ORIGIN');
let retryDelayMs = 2000;
const platform = new Platform({
  origin,
  onRetryAfter: (delay) => { retryDelayMs = delay; },
  token: required('OPSIFORCE_TOKEN'),
  tenant: process.env.OPSIFORCE_TENANT,
});
const run = new AbortController();
process.once('SIGINT', () => run.abort(new Error('interrupted by the operator')));

const project = await resolveProject();
const development = project.environments.find((environment) => environment.isDefault);
if (!development) throw new Error(`Project ${project.id} has no Development environment`);

print(`Project ${project.id} (${project.title ?? 'untitled'})`);
print(`  discovery: ${development.opencode.baseUrl}`);
print(`  remembered session: ${development.opencode.sessionId ?? 'none yet'}`);
const connection = await platform.connect(project.id, development.id, run.signal);
print(`Connected: session ${connection.sessionId}, runtime build ${connection.build ?? 'unreported'}`);

const opencode = runtimeClient(platform, connection);
const sessionID = connection.sessionId;
print(`Runtime spec: ${platform.resolve(connection.openapiUrl).href}`);
const events = opencode.event.subscribe({ signal: run.signal });
const watching = watch(events, sessionID);
const promptId = messageId();
const text = process.env.OPSIFORCE_PROMPT ?? 'In one sentence, what is in this workspace?';
const admitted = await admit(() =>
  opencode.session.prompt({ sessionID, id: promptId, text }, { signal: run.signal })
);
print(`Prompt ${admitted.id} admitted as ${admitted.delivery}`);
await opencode.session.wait({ sessionID }, { signal: run.signal });
print('Session is idle');

const page = await opencode.message.list({ sessionID, limit: 5, order: 'desc' }, { signal: run.signal });
print(`Last ${page.data.length} messages:`);
for (const message of page.data.toReversed()) {
  print(`  ${message.type.padEnd(10)} ${summarise(message)}`);
}
const stopped = await opencode.session.interrupt({ sessionID }, { signal: run.signal });
print(`Interrupt: ${stopped.interrupted ? 'stopped the turn' : 'nothing was running'}`);

const parked = await opencode.session.inbox.list({ sessionID }, { signal: run.signal });
print(`Inbox: ${parked.length} parked prompt(s)`);

run.abort(new Error('done'));
await watching.catch(() => undefined);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function resolveProject(): Promise<Project> {
  const existing = process.env.OPSIFORCE_PROJECT;
  if (existing) return platform.requestWithRetry<Project>(`/api/v1/projects/${existing}`, { signal: run.signal });

  const agents = await platform.requestWithRetry<{ items: Agent[] }>('/api/v1/agents?limit=1', { signal: run.signal });
  const agent = agents.items[0];
  if (!agent) throw new Error('No Agent profiles in this tenant');

  return platform.request<Project>('/api/v1/projects', {
    method: 'POST',
    signal: run.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Public API example', agentId: agent.id }),
  });
}

async function admit<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (run.signal.aborted) throw error;
    print('Prompt admission was ambiguous; replaying the same id and body');
    await sleep(retryDelayMs, run.signal);
    return send();
  }
}

async function watch(events: AsyncIterable<{ type: string }>, sessionID: string): Promise<void> {
  for await (const event of events) {
    const scoped = 'properties' in event ? (event.properties as { sessionID?: string }) : undefined;
    if (scoped?.sessionID !== undefined && scoped.sessionID !== sessionID) continue;
    print(`  event ${event.type}`);
  }
}

function summarise(message: { type: string; text?: string; content?: JsonValue }): string {
  const parts = Array.isArray(message.content) ? message.content : [];
  const fromParts = parts
    .filter((part): part is { type: string; text: string } => isTextPart(part))
    .map((part) => part.text)
    .join(' ');
  const text = (typeof message.text === 'string' ? message.text : fromParts).replaceAll('\n', ' ');
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function isTextPart(part: JsonValue): part is { type: string; text: string } {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: JsonValue }).type === 'text' &&
    typeof (part as { text?: JsonValue }).text === 'string'
  );
}

function messageId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const value = BigInt(Date.now()) * 0x1000n + 1n;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0')
  ).join('');
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return `msg_${time}${Array.from(bytes, (byte) => chars[byte % 62]).join('')}`;
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}
