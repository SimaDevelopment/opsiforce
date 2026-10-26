import { createHash } from 'node:crypto';
import type { BackendConfig } from './config.ts';

export interface LinkedAccountCredential {
  vendor: string;
  accessToken: string;
  accountId: string | null;
  expiresAt: string | null;
}

export interface CallerCredentials {
  current(): Promise<LinkedAccountCredential>;
  forceRefreshed(): Promise<LinkedAccountCredential>;
}

export interface CallerAccess {
  credentials: CallerCredentials;
  credential: LinkedAccountCredential;
}

export interface CredentialSource {
  forCaller(callerSecret: string): CallerCredentials;
}

export class UnknownCallerError extends Error {}

export class CredentialUnavailableError extends Error {}

const CREDENTIAL_PATH = '/api/internal/linked-accounts/credential';
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
const UNDATED_TOKEN_CACHE_MS = 60 * 1000;
const BACKEND_TIMEOUT_MS = 10_000;

interface CachedCredential {
  credential: LinkedAccountCredential;
  freshUntil: number;
}

function isCredential(value: unknown): value is LinkedAccountCredential {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.vendor === 'string' && typeof record.accessToken === 'string';
}

function freshUntilOf(credential: LinkedAccountCredential): number {
  const expiresAt = credential.expiresAt === null ? Number.NaN : Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt - REFRESH_BEFORE_EXPIRY_MS : Date.now() + UNDATED_TOKEN_CACHE_MS;
}

export function createCredentialSource(backend: BackendConfig): CredentialSource {
  const cache = new Map<string, CachedCredential>();

  async function fetchCredential(callerSecret: string, forceRefresh: boolean): Promise<LinkedAccountCredential> {
    let response: Response;
    try {
      response = await fetch(`${backend.url}${CREDENTIAL_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-linked-account-proxy-token': backend.serviceToken },
        body: JSON.stringify({ caller_secret: callerSecret, force_refresh: forceRefresh }),
        signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      });
    } catch {
      throw new CredentialUnavailableError('The backend could not be reached for the Linked account.');
    }
    if (response.status === 401 || response.status === 409) {
      throw new UnknownCallerError('The caller is not a signed-in Linked account.');
    }
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    if (!isCredential(body)) {
      throw new CredentialUnavailableError(`The backend did not return the Linked account (${response.status}).`);
    }
    return body;
  }

  async function load(callerSecret: string, cacheKey: string, forceRefresh: boolean): Promise<LinkedAccountCredential> {
    const credential = await fetchCredential(callerSecret, forceRefresh);
    cache.set(cacheKey, { credential, freshUntil: freshUntilOf(credential) });
    return credential;
  }

  return {
    forCaller(callerSecret) {
      const cacheKey = createHash('sha256').update(callerSecret).digest('hex');
      return {
        async current() {
          const cached = cache.get(cacheKey);
          if (cached && Date.now() < cached.freshUntil) return cached.credential;
          return load(callerSecret, cacheKey, false);
        },
        forceRefreshed: () => load(callerSecret, cacheKey, true),
      };
    },
  };
}
