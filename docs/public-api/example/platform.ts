export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Connection {
  readonly baseUrl: string;
  readonly openapiUrl: string;
  readonly sessionId: string;
  readonly build: string | null;
}

export interface PlatformOptions {
  readonly origin: string;
  readonly token: string;
  readonly onRetryAfter?: (delayMs: number) => void;
  readonly organization?: string;
}

export class PlatformError extends Error {
  readonly status: number;
  readonly apiError: JsonValue | undefined;
  readonly headers: Headers;

  constructor(status: number, apiError: JsonValue | undefined, headers: Headers) {
    super(`Platform answered ${status}`);
    this.name = 'PlatformError';
    this.status = status;
    this.apiError = apiError;
    this.headers = headers;
  }

  retryAfterMs(): number | null {
    return retryAfterMs(this.headers);
  }
}

export function retryAfterMs(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export class Platform {
  private readonly origin: URL;
  private readonly options: PlatformOptions;

  constructor(options: PlatformOptions) {
    this.options = options;
    this.origin = new URL(options.origin);
  }

  resolve(pathOrUrl: string): URL {
    const url = new URL(pathOrUrl, this.origin);
    if (url.origin !== this.origin.origin) {
      throw new Error(`Refusing to use ${url.origin}; this client only talks to ${this.origin.origin}`);
    }
    return url;
  }

  async fetch(input: Request, retryReads = true): Promise<Response> {
    this.resolve(input.url);
    const headers = new Headers(input.headers);
    headers.set('authorization', `Bearer ${this.options.token}`);
    if (this.options.organization) headers.set('x-tenant-name', this.options.organization);
    const request = new Request(input, { headers, redirect: 'error' });
    const safe = retryReads && (request.method === 'GET' || request.method === 'HEAD');
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(request.clone());
      if (!RETRYABLE_STATUS.has(response.status)) return response;
      const delay = retryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_SECONDS * 1000;
      this.options.onRetryAfter?.(delay);
      if (!safe || attempt >= 4) return response;
      await response.body?.cancel();
      await sleep(delay, request.signal);
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetch(new Request(this.resolve(path), init), false);

    const text = await response.text();
    const body: JsonValue | undefined = text.length > 0 ? JSON.parse(text) : undefined;
    if (!response.ok) throw new PlatformError(response.status, body, response.headers);
    return body as T;
  }

  async requestWithRetry<T>(path: string, init: RequestInit = {}, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.request<T>(path, init);
      } catch (error) {
        const transient = error instanceof PlatformError && RETRYABLE_STATUS.has(error.status);
        if (!transient || attempt >= attempts) throw error;
        await sleep(error.retryAfterMs() ?? DEFAULT_RETRY_AFTER_SECONDS * 1000, init.signal);
      }
    }
  }

  connect(projectId: string, environmentId: string, signal?: AbortSignal): Promise<Connection> {
    return this.requestWithRetry<Connection>(
      `/api/v1/projects/${projectId}/environments/${environmentId}/connect`,
      { method: 'POST', signal }
    );
  }
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
