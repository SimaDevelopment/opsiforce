import { OpenCode } from '@opencode-ai/client';
import type { Connection, Platform } from './platform.ts';

export function runtimeFetch(platform: Platform, connection: Connection): typeof fetch {
  const base = platform.resolve(connection.baseUrl);
  const prefix = base.pathname.replace(/\/$/, '');

  const prefixed = (input: URL): URL => {
    platform.resolve(input.href);
    if (input.pathname === prefix || input.pathname.startsWith(`${prefix}/`)) return input;

    const repaired = new URL(input.href);
    repaired.pathname = `${prefix}${input.pathname}`;
    return repaired;
  };

  const adapter: typeof fetch = (input, init) => {
    if (input instanceof URL) return platform.fetch(new Request(prefixed(input), init));
    if (typeof input === 'string') return platform.fetch(new Request(prefixed(new URL(input, base)), init));
    return platform.fetch(new Request(new Request(prefixed(new URL(input.url)), input), init));
  };

  return adapter;
}

export function runtimeClient(platform: Platform, connection: Connection) {
  return OpenCode.make({ baseUrl: platform.resolve(connection.baseUrl).href, fetch: runtimeFetch(platform, connection) });
}

export type RuntimeClient = ReturnType<typeof runtimeClient>;
