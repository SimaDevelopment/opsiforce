import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PodService } from '../pod/pod.service';
import { OpencodeErrorBody, PodResponded, PodTimeout, PodUnreachable } from './agent-session.errors';
import type { JsonObject } from '../common/json';
import type { RuntimeInfo, SessionInfo } from './agent-session.types';

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
  private readonly agentPort: number;

  constructor(
    configService: ConfigService,
    private readonly pods: PodService
  ) {
    this.agentPort = configService.getOrThrow<number>('agentPort');
  }

  async call<T>(environmentId: string, path: string, options: CallOptions = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.pods.podFetch(environmentId, this.agentPort, path, {
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

  async oldestRootSession(
    environmentId: string,
    options: CallOptions & { maxPages?: number } = {}
  ): Promise<SessionInfo | null> {
    const maxPages = options.maxPages ?? MAX_SESSION_LIST_PAGES;
    let oldest: SessionInfo | null = null;
    let path: string | null = '/api/session?parentID=null&order=asc';
    for (let pages = 0; path !== null; pages += 1) {
      const page: SessionPage = await this.call<SessionPage>(environmentId, path, options);
      const roots = (page.data ?? []).filter(isRootSession);
      if (roots.length > 0 && pages >= maxPages) {
        throw new PodTimeout(`Root session list did not end within ${maxPages} pages; refusing to bind a partial scan`);
      }
      for (const root of roots) if (oldest === null || createdBefore(root, oldest)) oldest = root;
      const next = page.cursor?.next ?? null;
      path = roots.length === 0 || next === null ? null : `/api/session?cursor=${encodeURIComponent(next)}`;
    }
    return oldest;
  }

  async createSession(environmentId: string, agent: string, options: CallOptions = {}): Promise<SessionInfo> {
    return this.callForData<SessionInfo>(environmentId, '/api/session', {
      ...options,
      method: 'POST',
      body: { agent },
    });
  }

  /** `POST /api/session/{id}/agent` — the runtime stores the id unvalidated and re-resolves it each step. */
  async switchSessionAgent(
    environmentId: string,
    sessionId: string,
    agent: string,
    options: CallOptions = {}
  ): Promise<void> {
    await this.call<void>(environmentId, `/api/session/${sessionId}/agent`, {
      ...options,
      method: 'POST',
      body: { agent },
    });
  }

  async getSession(environmentId: string, sessionId: string, options: CallOptions = {}): Promise<SessionInfo> {
    return this.callForData<SessionInfo>(environmentId, `/api/session/${sessionId}`, options);
  }

  async getSessionIfPresent(
    environmentId: string,
    sessionId: string,
    options: CallOptions = {}
  ): Promise<SessionInfo | null> {
    try {
      return await this.getSession(environmentId, sessionId, options);
    } catch (error) {
      if (error instanceof PodResponded && isConfirmedAbsence(error)) return null;
      throw error;
    }
  }

  async info(environmentId: string, options: CallOptions = {}): Promise<RuntimeInfo> {
    return this.call<RuntimeInfo>(environmentId, '/api/info', options);
  }

  /**
   * `GET /api/skill` — the ids opencode currently serves. A skill's id is its directory name under
   * `.opencode/skills/`, so this is what a delivery confirms itself against (ADR-0060).
   */
  async skillIds(environmentId: string, options: CallOptions = {}): Promise<string[]> {
    const listed = await this.call<{ data?: Array<{ id?: string }> }>(environmentId, '/api/skill', options);
    return (listed.data ?? []).flatMap((skill) => (skill.id === undefined ? [] : [skill.id]));
  }

  async agentIds(environmentId: string, options: CallOptions = {}): Promise<string[]> {
    const listed = await this.call<{ data?: Array<{ id?: string }> }>(environmentId, '/api/agent', options);
    return (listed.data ?? []).flatMap((agent) => (agent.id === undefined ? [] : [agent.id]));
  }

  async activeSessions(environmentId: string, timeoutMs: number): Promise<string[]> {
    const snapshot = await this.call<{ data?: Record<string, unknown> }>(environmentId, '/api/session/active', {
      timeoutMs,
    });
    return Object.keys(snapshot.data ?? {});
  }

  private async callForData<T>(environmentId: string, path: string, options: CallOptions = {}): Promise<T> {
    return unwrap(await this.call<T | Envelope<T>>(environmentId, path, options));
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
