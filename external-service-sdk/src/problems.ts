export const problemMediaType = 'application/problem+json';

export const problemTypePrefix = 'urn:opsiforce:error:';

export const serviceErrorStatuses = [400, 404, 409, 422, 429, 502] as const;

export type ServiceErrorStatus = (typeof serviceErrorStatuses)[number];

const problemCodePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  [extension: string]: unknown;
}

export function problemType(code: string): string {
  return `${problemTypePrefix}${code}`;
}

export function problemTitle(code: string): string {
  const words = code.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function problem(
  fields: { status: number; code: string; title?: string; detail?: string } & Record<string, unknown>
): ProblemDetails {
  const { status, code, title, detail, ...extensions } = fields;
  return {
    type: problemType(code),
    title: title ?? problemTitle(code),
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...extensions,
  };
}

export interface ServiceErrorOptions {
  status: number;
  code: string;
  detail?: string;
  title?: string;
  retryAfterSeconds?: number;
  extensions?: Record<string, unknown>;
}

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly title: string;
  readonly retryAfterSeconds: number | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(options: ServiceErrorOptions) {
    if (!problemCodePattern.test(options.code)) {
      throw new TypeError(`ServiceError code "${options.code}" must be kebab-case, like card-not-found`);
    }
    super(options.detail ?? problemTitle(options.code));
    this.name = 'ServiceError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail;
    this.title = options.title ?? problemTitle(options.code);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.extensions = options.extensions ?? {};
  }

  toProblem(): ProblemDetails {
    return problem({
      ...this.extensions,
      status: this.status,
      code: this.code,
      title: this.title,
      detail: this.detail,
      ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    });
  }
}

export function rateLimited(options: { retryAfterSeconds: number; detail?: string }): ServiceError {
  return new ServiceError({
    status: 429,
    code: 'rate-limited',
    detail: options.detail ?? 'The outside system is rate limiting calls; retry later.',
    retryAfterSeconds: options.retryAfterSeconds,
  });
}

export function upstreamUnauthorized(detail?: string): ServiceError {
  return new ServiceError({
    status: 502,
    code: 'upstream-unauthorized',
    detail: detail ?? 'The outside system refused the stored credentials.',
  });
}
