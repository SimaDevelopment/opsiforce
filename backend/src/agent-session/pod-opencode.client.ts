import { Injectable } from '@nestjs/common';
import { OpencodeErrorBody, PodResponded, PodTimeout, PodUnreachable } from './agent-session.errors';
import type { JsonObject } from '../common/json';
import type { RuntimeHealth, SessionInfo } from './agent-session.types';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SESSION_LIST_PAGES = 100;

interface SessionPage {
  data?: SessionInfo[];
  cursor?: { next?: string | null };
}

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: JsonObject;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Envelope<T> {
  data: T;
}

function unwrap<T>(payload: T | Envelope<T>): T {
  if (payload !== null && typeof payload === 'object' && 'data' in payload) {
    return (payload as Envelope<T>).data;
  }
  return payload as T;
}

@Injectable()
export class PodOpencodeClient {
  async call<T>(upstream: string, path: string, options: CallOptions = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${upstream}${path}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw toTransportError(error);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) throw new PodResponded(res.status, parseErrorBody(text), text);
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  async oldestRootSession(upstream: string, options: CallOptions = {}): Promise<SessionInfo | null> {
    let oldest: SessionInfo | null = null;
    let path: string | null = '/api/session?parentID=null&order=asc';
    for (let pages = 0; path !== null && pages < MAX_SESSION_LIST_PAGES; pages += 1) {
      const page: SessionPage = await this.call<SessionPage>(upstream, path, options);
      const roots = (page.data ?? []).filter(isRootSession);
      for (const root of roots) if (oldest === null || createdBefore(root, oldest)) oldest = root;
      const next = page.cursor?.next ?? null;
      path = roots.length === 0 || next === null ? null : `/api/session?cursor=${encodeURIComponent(next)}`;
    }
    return oldest;
  }

  async createSession(upstream: string, options: CallOptions = {}): Promise<SessionInfo> {
    return this.callForData<SessionInfo>(upstream, '/api/session', { ...options, method: 'POST', body: {} });
  }

  async getSession(upstream: string, sessionId: string, options: CallOptions = {}): Promise<SessionInfo> {
    return this.callForData<SessionInfo>(upstream, `/api/session/${sessionId}`, options);
  }

  async getSessionIfPresent(
    upstream: string,
    sessionId: string,
    options: CallOptions = {}
  ): Promise<SessionInfo | null> {
    try {
      return await this.getSession(upstream, sessionId, options);
    } catch (error) {
      if (error instanceof PodResponded && isConfirmedAbsence(error)) return null;
      throw error;
    }
  }

  async health(upstream: string, options: CallOptions = {}): Promise<RuntimeHealth> {
    return this.call<RuntimeHealth>(upstream, '/api/health', options);
  }

  async activeSessions(upstream: string, timeoutMs: number): Promise<string[]> {
    const snapshot = await this.call<{ data?: Record<string, unknown> }>(upstream, '/api/session/active', {
      timeoutMs,
    });
    return Object.keys(snapshot.data ?? {});
  }

  private async callForData<T>(upstream: string, path: string, options: CallOptions = {}): Promise<T> {
    return unwrap(await this.call<T | Envelope<T>>(upstream, path, options));
  }
}

export function isRootSession(session: SessionInfo): boolean {
  return session.parentID === undefined || session.parentID === null;
}

function createdBefore(candidate: SessionInfo, current: SessionInfo): boolean {
  if (candidate.time.created !== current.time.created) return candidate.time.created < current.time.created;
  return candidate.id > current.id;
}

function isConfirmedAbsence(error: PodResponded): boolean {
  return error.status === 404 && error.tag !== 'UnknownError';
}

function parseErrorBody(text: string): OpencodeErrorBody | null {
  try {
    return JSON.parse(text) as OpencodeErrorBody;
  } catch {
    return null;
  }
}

function toTransportError(error: unknown): PodTimeout | PodUnreachable {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new PodTimeout(message);
  }
  return new PodUnreachable(message);
}
