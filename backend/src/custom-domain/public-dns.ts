import type { SoaRecord } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import type { Provider } from '@nestjs/common';

export const PUBLIC_DNS = 'PUBLIC_DNS';

export interface PublicDns {
  resolveSoa(name: string): Promise<SoaRecord>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

const PUBLIC_RESOLVERS = ['8.8.8.8', '1.1.1.1'];
const QUERY_TIMEOUT_MS = 2_000;
const TRIES_PER_SERVER = 2;
const NO_SUCH_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'EBADRESP']);

export class DnsUnreachable extends Error {
  constructor(name: string, cause: unknown) {
    super(`Public DNS did not answer for ${name}`, { cause });
    this.name = 'DnsUnreachable';
  }
}

export async function recordOrNone<T>(name: string, lookup: () => Promise<T>): Promise<T | null> {
  try {
    return await lookup();
  } catch (err) {
    if (NO_SUCH_RECORD.has((err as { code?: string }).code ?? '')) return null;
    throw new DnsUnreachable(name, err);
  }
}

export const publicDnsProvider: Provider = {
  provide: PUBLIC_DNS,
  useFactory: (): PublicDns => {
    const resolver = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: TRIES_PER_SERVER });
    resolver.setServers(PUBLIC_RESOLVERS);
    return resolver;
  },
};
