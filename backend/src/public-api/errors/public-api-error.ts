import { HttpException } from '@nestjs/common';
import {
  fallbackSlugForStatus,
  hasFallbackSlug,
  ERROR_TYPES,
  errorTypeUri,
  RETRY_AFTER_HEADER,
  retryAfterSecondsOf,
  type ErrorSlug,
} from './error-types';
import type { OrganizationRef, ApiError, ValidationErrorItem } from './error.schema';

type ErrorExtensions = Partial<Pick<ApiError, 'detail' | 'errors' | 'organizations' | 'permission'>>;

export class PublicApiError extends HttpException {
  constructor(
    readonly slug: ErrorSlug,
    private readonly extensions: ErrorExtensions = {},
    readonly headers: Readonly<Record<string, string>> = {},
    status: number = ERROR_TYPES[slug].status
  ) {
    super(ERROR_TYPES[slug].title, status);
  }

  toApiError(instance: string): ApiError {
    const { title } = ERROR_TYPES[this.slug];
    return { type: errorTypeUri(this.slug), title, status: this.getStatus(), instance, ...this.extensions };
  }
}

function retryAfterHeader(slug: ErrorSlug): Record<string, string> {
  const seconds = retryAfterSecondsOf(slug);
  return seconds === null ? {} : { [RETRY_AFTER_HEADER]: String(seconds) };
}

export const Errors = {
  validationError: (errors: ValidationErrorItem[]) =>
    new PublicApiError('validation-error', { detail: 'One or more request fields are invalid', errors }),
  invalidReference: (errors: ValidationErrorItem[]) =>
    new PublicApiError('invalid-reference', { detail: 'One or more referenced resources do not exist', errors }),
  organizationRequired: (organizations: OrganizationRef[]) =>
    new PublicApiError('organization-required', {
      detail: 'You belong to several organizations; pick one with the x-tenant-name header',
      organizations,
    }),
  unauthenticated: () => new PublicApiError('unauthenticated', { detail: 'Send a bearer token issued by the IdP' }),
  organizationForbidden: () => new PublicApiError('organization-forbidden'),
  permissionDenied: (permission: string) =>
    new PublicApiError('permission-denied', { detail: `Missing permission: ${permission}`, permission }),
  projectNotFound: () => new PublicApiError('project-not-found'),
  routeNotFound: () => new PublicApiError('route-not-found'),
  environmentDisabled: () =>
    new PublicApiError('environment-disabled', { detail: 'This environment is disabled; enable it to continue' }),
  environmentStarting: () =>
    new PublicApiError(
      'environment-starting',
      { detail: 'The environment is starting; retry shortly' },
      retryAfterHeader('environment-starting')
    ),
  environmentFailed: () =>
    new PublicApiError('environment-failed', { detail: 'The environment failed to start; restart the project' }),
  agentUnreachable: () => new PublicApiError('agent-unreachable', { detail: 'The agent could not be reached' }),
  agentTimeout: () => new PublicApiError('agent-timeout', { detail: 'The agent did not respond in time' }),
  unexpected: () => new PublicApiError('unexpected'),
  fromForeignStatus: (status: number, detail: string) =>
    new PublicApiError(fallbackSlugForStatus(status), { detail }, {}, hasFallbackSlug(status) ? undefined : status),
};
