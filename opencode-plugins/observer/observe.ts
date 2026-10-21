import { format } from 'node:util';

export const OBSERVER_ID = 'opsiforce.observer';
const OBSERVATIONS_PATH = '/agent/observations';
const POST_ATTEMPTS = 4;
const POST_BACKOFF_MS = 1500;
const POST_TIMEOUT_MS = 5000;
const RESUBSCRIBE_DELAY_MS = 1000;

const RUN_KINDS: Partial<Record<string, 'run.started' | 'run.ended'>> = {
  'session.execution.started': 'run.started',
  'session.execution.succeeded': 'run.ended',
  'session.execution.failed': 'run.ended',
  'session.execution.interrupted': 'run.ended',
};

export type OpencodeEvent = { readonly type: string; readonly data?: unknown };

type Observation =
  | { kind: 'run.started' | 'run.ended'; sessionId: string }
  | { kind: 'titled'; sessionId: string; root: boolean; title: string }
  | { kind: 'prompted'; sessionId: string; root: boolean };

type GetSession = (sessionID: string) => Promise<{ parentID?: string }>;

export type ObserverHost = {
  env: Record<string, string | undefined>;
  subscribe: (options: { signal: AbortSignal }) => AsyncIterable<OpencodeEvent>;
  getSession: GetSession;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (...args: unknown[]) => void;
};

export function startObserver(host: ObserverHost): () => void {
  const { SERVICE_GATEWAY_URL: gatewayUrl, SERVICE_GATEWAY_API_KEY: gatewayKey } = host.env;
  if (!gatewayUrl || !gatewayKey) {
    throw new Error(`${OBSERVER_ID}: SERVICE_GATEWAY_URL and SERVICE_GATEWAY_API_KEY must be set`);
  }
  const observationsUrl = `${gatewayUrl.replace(/\/+$/, '')}${OBSERVATIONS_PATH}`;
  const httpFetch = host.fetch ?? fetch;
  const sleep = host.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = host.log ?? ((...args) => process.stderr.write(`[${OBSERVER_ID}] ${format(...args)}\n`));

  const post = async (observation: Observation) => {
    const body = JSON.stringify(observation);
    for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(POST_BACKOFF_MS * (attempt - 1));
      try {
        const response = await httpFetch(observationsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewayKey}` },
          body,
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        await response.body?.cancel();
        if (response.ok) return;
        log(`POST ${OBSERVATIONS_PATH} attempt ${attempt} returned status ${response.status}`);
      } catch (error) {
        log(`POST ${OBSERVATIONS_PATH} attempt ${attempt} failed`, error);
      }
    }
    log(`POST ${OBSERVATIONS_PATH} dropped after ${POST_ATTEMPTS} attempts`, body);
  };

  const handle = async (event: OpencodeEvent) => {
    try {
      const observation = await observationFor(event, host.getSession);
      if (observation) await post(observation);
    } catch (error) {
      log(`${event.type} handler threw`, error);
    }
  };

  const controller = new AbortController();
  const { signal } = controller;
  void (async () => {
    while (!signal.aborted) {
      try {
        for await (const event of host.subscribe({ signal })) void handle(event);
        return;
      } catch (error) {
        log(`event stream failed, resubscribing in ${RESUBSCRIBE_DELAY_MS} ms`, error);
        await sleep(RESUBSCRIBE_DELAY_MS);
      }
    }
  })();
  return () => controller.abort();
}

type EventData = { sessionID?: unknown; title?: unknown; item?: { type?: unknown } };

async function observationFor(event: OpencodeEvent, getSession: GetSession): Promise<Observation | undefined> {
  const { sessionID: sessionId, title, item } = (event.data ?? {}) as EventData;
  if (typeof sessionId !== 'string') return undefined;
  const isRoot = async () => (await getSession(sessionId)).parentID === undefined;
  const runKind = RUN_KINDS[event.type];
  if (runKind) return { kind: runKind, sessionId };
  if (event.type === 'session.renamed' && typeof title === 'string') {
    return { kind: 'titled', sessionId, root: await isRoot(), title };
  }
  if (event.type === 'session.inbox.enqueued' && item?.type === 'user') {
    return { kind: 'prompted', sessionId, root: await isRoot() };
  }
  return undefined;
}
