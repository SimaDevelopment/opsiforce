import { HttpStatus } from '@nestjs/common';

export const ERROR_TYPE_PREFIX = 'urn:opsiforce:error:';

export const ERROR_TYPES = {
  'validation-error': { status: HttpStatus.BAD_REQUEST, title: 'Request validation failed' },
  'invalid-reference': { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Referenced resource is unknown' },
  'organization-required': { status: HttpStatus.BAD_REQUEST, title: 'Organization must be selected' },
  unauthenticated: { status: HttpStatus.UNAUTHORIZED, title: 'Authentication required' },
  'organization-forbidden': { status: HttpStatus.FORBIDDEN, title: 'Organization is not accessible' },
  'permission-denied': { status: HttpStatus.FORBIDDEN, title: 'Permission denied' },
  'project-not-found': { status: HttpStatus.NOT_FOUND, title: 'Project not found' },
  'route-not-found': { status: HttpStatus.NOT_FOUND, title: 'Route not found' },
  'environment-disabled': { status: HttpStatus.LOCKED, title: 'Environment is disabled' },
  'environment-starting': { status: HttpStatus.SERVICE_UNAVAILABLE, title: 'Environment is starting' },
  'environment-failed': { status: HttpStatus.SERVICE_UNAVAILABLE, title: 'Environment failed to start' },
  'agent-unreachable': { status: HttpStatus.BAD_GATEWAY, title: 'Agent is unreachable' },
  'agent-timeout': { status: HttpStatus.GATEWAY_TIMEOUT, title: 'Agent did not respond in time' },
  'name-unavailable': { status: HttpStatus.CONFLICT, title: 'Name is unavailable' },
  'validation-failed': { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Skill validation failed' },
  'visibility-incoherent': { status: HttpStatus.FORBIDDEN, title: 'Visibility would become incoherent' },
  'skill-in-use': { status: HttpStatus.CONFLICT, title: 'Skill is carried by an Agent' },
  'duplicate-skill-name': { status: HttpStatus.CONFLICT, title: 'Skill name is already carried' },
  'model-unknown': { status: HttpStatus.CONFLICT, title: 'Model is unknown to this deployment' },
  'not-publishable': { status: HttpStatus.CONFLICT, title: 'Resource is not publishable' },
  unexpected: { status: HttpStatus.INTERNAL_SERVER_ERROR, title: 'Unexpected error' },
  'bad-request': { status: HttpStatus.BAD_REQUEST, title: 'Bad request' },
  unauthorized: { status: HttpStatus.UNAUTHORIZED, title: 'Unauthorized' },
  forbidden: { status: HttpStatus.FORBIDDEN, title: 'Forbidden' },
  'not-found': { status: HttpStatus.NOT_FOUND, title: 'Not found' },
  conflict: { status: HttpStatus.CONFLICT, title: 'Conflict' },
  unprocessable: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Unprocessable content' },
} as const satisfies Record<string, { status: HttpStatus; title: string }>;

export type ErrorSlug = keyof typeof ERROR_TYPES;

export const ERROR_SLUGS = Object.keys(ERROR_TYPES) as ErrorSlug[];

const FALLBACK_BY_STATUS: Partial<Record<number, ErrorSlug>> = {
  [HttpStatus.BAD_REQUEST]: 'bad-request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not-found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'unprocessable',
};

export function fallbackSlugForStatus(status: number): ErrorSlug {
  return FALLBACK_BY_STATUS[status] ?? 'bad-request';
}

export function hasFallbackSlug(status: number): boolean {
  return status in FALLBACK_BY_STATUS;
}

export function errorTypeUri(slug: ErrorSlug): string {
  return `${ERROR_TYPE_PREFIX}${slug}`;
}

export const RETRY_AFTER_HEADER = 'retry-after';

const RETRY_AFTER_SECONDS: Partial<Record<ErrorSlug, number>> = {
  'environment-starting': 5,
};

export function retryAfterSecondsOf(slug: ErrorSlug): number | null {
  return RETRY_AFTER_SECONDS[slug] ?? null;
}
