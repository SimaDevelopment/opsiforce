export type EnvironmentNotRunningState = 'starting' | 'disabled' | 'failed' | 'not-found';

export class EnvironmentNotRunning extends Error {
  constructor(readonly state: EnvironmentNotRunningState) {
    super(`Project environment is ${state}`);
    this.name = 'EnvironmentNotRunning';
  }
}

export class PodUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PodUnreachable';
  }
}

export class PodTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PodTimeout';
  }
}

export interface OpencodeErrorBody {
  _tag?: string;
  message?: string;
  field?: string | null;
  resource?: string | null;
  sessionID?: string | null;
  service?: string | null;
  ref?: string | null;
}

export class PodResponded extends Error {
  readonly tag: string;

  constructor(
    readonly status: number,
    readonly body: OpencodeErrorBody | null,
    readonly rawBody: string
  ) {
    super(body?.message ?? `opencode responded ${status}`);
    this.name = 'PodResponded';
    this.tag = body?._tag ?? '';
  }
}

export function isPodFailure(error: unknown): boolean {
  if (error instanceof PodUnreachable) return true;
  if (!(error instanceof PodResponded)) return false;
  return error.status >= 500 || error.tag === 'UnknownError' || error.tag === 'ServiceUnavailableError';
}
