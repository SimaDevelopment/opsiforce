import { problem, type ProblemDetails } from '@opsiforce/external-service-sdk';
import { reloadingRetryAfterSeconds } from '@opsiforce/external-service-sdk/server';
import type { DispatchFailureCode, ServiceDispatchError } from './service-dispatcher';
import { SERVICE_STARTING_RETRY_AFTER_SECONDS } from './service-pods';
import type { UnservableCustomService } from '../registry/custom-service-catalog';

export class GateRefusal extends Error {
  constructor(
    readonly refusal: ProblemDetails,
    readonly headers: Record<string, string> = {}
  ) {
    super(refusal.detail ?? refusal.code);
  }
}

export class DefaultMovedRefusal extends GateRefusal {
  constructor(slug: string) {
    super(
      problem({
        status: 503,
        code: 'service-moved',
        detail: `"${slug}" moved its Default environment while this call waited; retry shortly.`,
        service: slug,
      }),
      { 'retry-after': String(reloadingRetryAfterSeconds) }
    );
  }
}

export function refuse(fields: Parameters<typeof problem>[0], headers?: Record<string, string>): never {
  throw new GateRefusal(problem(fields), headers);
}

export function refuseUnknownCaller(): never {
  refuse({
    status: 401,
    code: 'unauthorized',
    detail: 'Send the environment service key: Authorization: Bearer gw-…',
  });
}

export function unknownServiceProblem(slug: string): ProblemDetails {
  return problem({
    status: 404,
    code: 'unknown-service',
    detail: `There is no External Service "${slug}".`,
    service: slug,
  });
}

export function refuseUnconfiguredService(slug: string): never {
  refuse({
    status: 503,
    code: 'service-not-configured',
    detail: `"${slug}" is not set up on this platform yet.`,
    service: slug,
  });
}

const dispatchFailureStatus: Record<DispatchFailureCode, number> = {
  'service-failed': 502,
  timeout: 502,
  'response-too-large': 502,
  'service-starting': 503,
  'service-reloading': 503,
  'service-disabled': 503,
};

export function refuseDispatchFailure(slug: string, error: ServiceDispatchError): never {
  refuse(
    { status: dispatchFailureStatus[error.code], code: error.code, detail: error.message, service: slug },
    retryAfterOf(error.code)
  );
}

function retryAfterOf(code: DispatchFailureCode): Record<string, string> | undefined {
  if (code === 'service-starting') return { 'retry-after': String(SERVICE_STARTING_RETRY_AFTER_SECONDS) };
  if (code === 'service-reloading') return { 'retry-after': String(reloadingRetryAfterSeconds) };
  return undefined;
}

export function disabledServiceProblem(slug: string): ProblemDetails {
  return problem({
    status: 503,
    code: 'service-disabled',
    detail: `"${slug}" is disabled by its Organization.`,
    service: slug,
  });
}

export function refuseDisabledService(slug: string): never {
  throw new GateRefusal(disabledServiceProblem(slug));
}

export function unservableServiceProblem(error: UnservableCustomService): ProblemDetails {
  if (error.disabled) return disabledServiceProblem(error.slug);
  return problem({
    status: 502,
    code: 'service-failed',
    detail: `The files of "${error.slug}" cannot be served: ${error.message}`,
    service: error.slug,
  });
}
