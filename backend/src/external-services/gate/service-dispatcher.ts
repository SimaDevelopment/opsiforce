import { Injectable, Logger } from '@nestjs/common';
import {
  callerIdentityHeader,
  expectedManifestHeader,
  formCallTimeoutSeconds,
  manifestHeader,
  mintCallerIdentity,
  wellKnownPath,
} from '@opsiforce/external-service-sdk/server';
import { failureMessages } from '@opsiforce/external-service-sdk/platform';
import { GatewayKeyService } from '../../gateway/gateway-key.service';
import { BuiltInsAdapter, isAdaptedBuiltIn, type AdaptedBuiltIn } from '../built-ins/built-ins-adapter';
import type { RegisteredService } from '../registry/service-registry';
import { FORM_ANSWER_LIMIT } from './gate-routes';
import { DefaultLaneHolds } from './default-lane-holds';
import { platformCallerOf } from './gate-caller';
import { ServicePods, UnreachablePod, type ServicePod } from './service-pods';

export type DispatchFailureCode =
  | 'service-failed'
  | 'timeout'
  | 'response-too-large'
  | 'service-starting'
  | 'service-reloading'
  | 'service-disabled';

export class ServiceDispatchError extends Error {
  constructor(
    readonly code: DispatchFailureCode,
    detail: string
  ) {
    super(detail);
  }
}

function nameOf(service: Pick<RegisteredService, 'manifest'>): string {
  return service.manifest.displayName;
}

function updating(service: Pick<RegisteredService, 'manifest'>): string {
  return `${nameOf(service)} is updating to a new version. Try again in a moment.`;
}

function unreachable(service: Pick<RegisteredService, 'manifest'>): ServiceDispatchError {
  return new ServiceDispatchError('service-failed', `${nameOf(service)} couldn't be reached. Try again in a moment.`);
}

const unreachablePodWording: Record<UnreachablePod['code'], (name: string) => string> = {
  'service-disabled': (name) => `${name} is turned off.`,
  'service-failed': (name) => `${name} couldn't start.`,
  'service-starting': (name) => `${name} is starting. Try again in a moment.`,
};

export class DefaultLaneMoved extends ServiceDispatchError {
  constructor(service: Pick<RegisteredService, 'manifest'>) {
    super('service-reloading', updating(service));
  }
}

export interface PlatformCallTarget {
  tenantId: string;
  projectId: string;
  projectEnvironmentId: string;
  environment: string;
}

export function platformCallTargetOf(caller: PlatformCallTarget): PlatformCallTarget {
  return {
    tenantId: caller.tenantId,
    projectId: caller.projectId,
    projectEnvironmentId: caller.projectEnvironmentId,
    environment: caller.environment,
  };
}

interface Exchange {
  gatewayKey: string;
  describedAs: string;
  send(path: string, init: RequestInit): Promise<Response>;
}

export type PlatformRoute = 'options' | 'info' | 'buttons' | 'hooks';

export interface PodDispatchRequest {
  route: PlatformRoute;
  name: string;
  body: unknown;
  signal?: AbortSignal;
  for?: PlatformCallTarget;
}

export interface ServiceResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const HTTP_GRACE_SECONDS = 5;

class ResponseTooLarge extends Error {}

function wellKnownPathOf(request: PodDispatchRequest): string {
  return `${wellKnownPath}/${request.route}/${encodeURIComponent(request.name)}`;
}

async function bodyWithin(response: Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) {
        await response.body.cancel().catch(() => undefined);
        throw new ResponseTooLarge();
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function tooLarge(service: Pick<RegisteredService, 'manifest'>): ServiceDispatchError {
  return new ServiceDispatchError('response-too-large', failureMessages.failed(nameOf(service)));
}

@Injectable()
export class ServiceDispatcher {
  private readonly logger = new Logger(ServiceDispatcher.name);

  constructor(
    private readonly pods: ServicePods,
    private readonly keys: GatewayKeyService,
    private readonly holds: DefaultLaneHolds,
    private readonly builtIns: BuiltInsAdapter
  ) {}

  async dispatch(service: RegisteredService, request: PodDispatchRequest): Promise<ServiceResponse> {
    if (service.home?.lane !== 'default') return this.dispatchNow(service, request);
    const entry = this.holds.enter(service.id, service.home.environmentId);
    if (entry === 'moved') throw new DefaultLaneMoved(service);
    if (entry === 'held') throw new ServiceDispatchError('service-reloading', updating(service));
    try {
      return await this.dispatchNow(service, request);
    } finally {
      this.holds.leave(service.id);
    }
  }

  private async dispatchNow(service: RegisteredService, request: PodDispatchRequest): Promise<ServiceResponse> {
    const pod = await this.podFor(service);
    if (pod) return this.overHttp(service, pod, request);
    if (isAdaptedBuiltIn(service)) return this.exchange(service, this.adapted(service), request);
    throw unreachable(service);
  }

  private adapted(service: AdaptedBuiltIn): Exchange {
    return {
      gatewayKey: this.builtIns.keyOf(service),
      describedAs: `"${service.slug}"`,
      send: (path, init) => {
        const headers = new Headers(init.headers);
        headers.set('host', 'built-in.local');
        return this.builtIns.answer(service, {
          method: init.method ?? 'POST',
          target: path,
          headers,
          body: typeof init.body === 'string' ? new Blob([init.body]).stream() : null,
          ...(init.signal ? { signal: init.signal } : {}),
        });
      },
    };
  }

  private async podFor(service: RegisteredService): Promise<ServicePod | undefined> {
    if (!service.home) return this.pods.podOf(service.id);
    try {
      return await this.pods.reach(service.home);
    } catch (error) {
      if (!(error instanceof UnreachablePod)) throw error;
      if (error.code === 'service-failed') this.logger.warn(`The pod of "${service.slug}": ${error.message}`);
      throw new ServiceDispatchError(error.code, unreachablePodWording[error.code](nameOf(service)));
    }
  }

  private async overHttp(
    service: RegisteredService,
    pod: ServicePod,
    request: PodDispatchRequest
  ): Promise<ServiceResponse> {
    const gatewayKey = await this.keys.getEnvironmentToken(pod.projectEnvironmentId);
    if (!gatewayKey) {
      this.logger.error(`The pod of "${service.slug}" has no service key (${pod.projectEnvironmentId})`);
      throw unreachable(service);
    }
    return this.exchange(
      service,
      {
        gatewayKey,
        describedAs: `The pod of "${service.slug}"`,
        send: (path, init) => fetch(new URL(path, pod.url), init),
      },
      request,
      pod.projectEnvironmentId
    );
  }

  private async exchange(
    service: RegisteredService,
    target: Exchange,
    request: PodDispatchRequest,
    projectEnvironmentId?: string
  ): Promise<ServiceResponse> {
    const { gatewayKey } = target;
    const timeoutSeconds = formCallTimeoutSeconds + HTTP_GRACE_SECONDS;
    const limit = FORM_ANSWER_LIMIT;
    let response: Response;
    let body: Uint8Array;
    try {
      response = await target.send(wellKnownPathOf(request), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [callerIdentityHeader]: this.platformIdentity(service, request, gatewayKey),
          [expectedManifestHeader]: service.manifestHash,
        },
        body: JSON.stringify(request.body),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutSeconds * 1000)])
          : AbortSignal.timeout(timeoutSeconds * 1000),
      });
      body = await bodyWithin(response, limit);
    } catch (error) {
      if (error instanceof ResponseTooLarge) {
        this.logger.warn(`${target.describedAs} answered with more than ${limit} bytes`);
        throw tooLarge(service);
      }
      if ((error as Error).name === 'TimeoutError') {
        this.logger.warn(`${target.describedAs} did not answer within ${timeoutSeconds} s`);
        throw new ServiceDispatchError('timeout', `${nameOf(service)} didn't answer in time. Try again in a moment.`);
      }
      this.logger.warn(`${target.describedAs} could not be reached: ${(error as Error).message}`);
      throw unreachable(service);
    }

    if (response.status === 503 && response.headers.get(manifestHeader) !== service.manifestHash) {
      throw new ServiceDispatchError('service-reloading', updating(service));
    }
    if (response.status === 401) {
      this.logger.error(
        `${target.describedAs} refused the platform's Caller identity for ${projectEnvironmentId ?? 'the platform'}`
      );
      throw unreachable(service);
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  }

  private platformIdentity(service: RegisteredService, request: PodDispatchRequest, gatewayKey: string): string {
    return mintCallerIdentity({ ...platformCallerOf(service.tenantId), ...request.for }, gatewayKey);
  }
}
