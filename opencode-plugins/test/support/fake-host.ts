import type { ObserverHost, OpencodeEvent } from '../../observer/observe.ts';

export const GATEWAY_URL = 'http://service-gateway.test/gw';
export const GATEWAY_KEY = 'gw-test-key';

export type Post = { url: string; authorization: string | null; contentType: string | null; body: unknown };

export type FakeHost = ObserverHost & {
  posts: Post[];
  logged: unknown[][];
  sleeps: number[];
  emit(event: OpencodeEvent): void;
  failStream(error: Error): void;
  subscriptions: number;
};

type Options = {
  env?: Record<string, string | undefined>;
  sessions?: Record<string, { parentID?: string }>;
  respond?: (attempt: number) => Response;
};

export function fakeHost(options: Options = {}): FakeHost {
  const queue: Array<OpencodeEvent | { fail: Error }> = [];
  let wake: (() => void) | undefined;
  let attempts = 0;
  const host: FakeHost = {
    posts: [],
    logged: [],
    sleeps: [],
    subscriptions: 0,
    env: options.env ?? { SERVICE_GATEWAY_URL: GATEWAY_URL, SERVICE_GATEWAY_API_KEY: GATEWAY_KEY },
    emit(event) {
      queue.push(event);
      wake?.();
    },
    failStream(error) {
      queue.push({ fail: error });
      wake?.();
    },
    subscribe({ signal }) {
      host.subscriptions++;
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const next = queue.shift();
            if (next && 'fail' in next) throw next.fail;
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
        },
      };
    },
    async getSession(sessionID) {
      const session = options.sessions?.[sessionID];
      if (!session) throw new Error(`Session not found: ${sessionID}`);
      return session;
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      host.posts.push({
        url: String(input),
        authorization: headers.get('authorization'),
        contentType: headers.get('content-type'),
        body,
      });
      attempts++;
      return options.respond ? options.respond(attempts) : new Response(null, { status: 202 });
    },
    log: (...args) => {
      host.logged.push(args);
    },
    sleep: async (ms) => {
      host.sleeps.push(ms);
    },
  };
  return host;
}

export async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function bodies(host: FakeHost) {
  return host.posts.map((post) => post.body);
}
