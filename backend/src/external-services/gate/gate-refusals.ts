import { reloadingRetryAfterSeconds } from '@opsiforce/external-service-sdk/server';
import { problem, type ProblemDetails } from '../http/problem-reply';
import type { RegisteredService } from '../registry/service-registry';
import type { DispatchFailureCode, ServiceDispatchError } from './service-dispatcher';
import { SERVICE_STARTING_RETRY_AFTER_SECONDS } from './service-pods';

export class GateRefusal extends Error {
  constructor(
    readonly refusal: ProblemDetails,
    readonly headers: Record<string, string> = {}
  ) {
    super(refusal.detail ?? refusal.code);
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

export function refuseUnconfiguredService(service: Pick<RegisteredService, 'slug' | 'manifest'>): never {
  refuse({
    status: 503,
    code: 'service-not-configured',
    detail: `${service.manifest.displayName} is not set up on this platform yet.`,
    service: service.slug,
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
