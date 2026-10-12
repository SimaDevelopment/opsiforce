import { Injectable, Logger } from '@nestjs/common';
import { handlerTimeoutSeconds, serviceErrorStatuses } from '@opsiforce/external-service-sdk/platform';
import {
  expectedManifestHeader,
  gatewayKeyHeader,
  manifestHeader,
  type DispatchRequest,
  type ServiceResponse,
} from '@opsiforce/external-service-sdk/server';
import { GatewayKeyService } from '../../gateway/gateway-key.service';
import type { RegisteredService } from '../registry/service-registry';
import { GATE_RESPONSE_LIMIT } from './gate-routes';
import { DefaultLaneHolds, INBOUND_HOLD_WAIT_MS } from './default-lane-holds';
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

export class DefaultLaneMoved extends ServiceDispatchError {
  constructor(slug: string) {
    super('service-reloading', `"${slug}" moved its Default environment; retry shortly.`);
  }
}

const HTTP_GRACE_SECONDS = 5;

const SERVICE_ANSWER_STATUSES: ReadonlySet<number> = new Set([200, 204, ...serviceErrorStatuses]);

class ResponseTooLarge extends Error {}

function isOutOfBoundsRefusal(status: number, body: Uint8Array): boolean {
  if (status !== 403) return false;
  try {
    return (JSON.parse(new TextDecoder().decode(body)) as { code?: unknown }).code === 'out-of-bounds';
  } catch {
    return false;
  }
}

function servicePath(request: DispatchRequest): string {
  if (request.route === 'inbound') return '/_service/inbound';
  return `/_service/${request.route}/${encodeURIComponent(request.name ?? '')}`;
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

function tooLarge(): ServiceDispatchError {
  return new ServiceDispatchError(
    'response-too-large',
    `The service answered with more than ${GATE_RESPONSE_LIMIT} bytes.`
  );
}

@Injectable()
export class ServiceDispatcher {
  private readonly logger = new Logger(ServiceDispatcher.name);

  constructor(
    private readonly pods: ServicePods,
    private readonly keys: GatewayKeyService,
    private readonly holds: DefaultLaneHolds
  ) {}

  runsInProcess(
    service: RegisteredService
  ): service is RegisteredService & { runtime: NonNullable<RegisteredService['runtime']> } {
    return service.home === null && service.runtime !== null && !this.pods.podOf(service.id);
  }

  async dispatch(service: RegisteredService, request: DispatchRequest): Promise<ServiceResponse> {
    if (service.home?.lane !== 'default') return this.dispatchNow(service, request);
    const holdWaitMs = request.route === 'inbound' ? INBOUND_HOLD_WAIT_MS : 0;
    const entry = await this.holds.enterWaiting(service.id, service.home.environmentId, holdWaitMs);
    if (entry === 'moved') throw new DefaultLaneMoved(service.slug);
    if (entry === 'held') {
      throw new ServiceDispatchError(
        'service-reloading',
        `"${service.slug}" is switching its Default environment; retry shortly.`
      );
    }
    try {
      return await this.dispatchNow(service, request);
    } finally {
      this.holds.leave(service.id);
    }
  }

  private async dispatchNow(service: RegisteredService, request: DispatchRequest): Promise<ServiceResponse> {
    const pod = await this.podFor(service);
    const expecting = { ...request, expectedManifestHash: service.manifestHash };
    return pod ? this.overHttp(service, pod, expecting) : this.inProcess(service, expecting);
  }

  private async podFor(service: RegisteredService): Promise<ServicePod | undefined> {
    if (!service.home) return this.pods.podOf(service.id);
    try {
      return await this.pods.reach(service.home);
    } catch (error) {
      if (!(error instanceof UnreachablePod)) throw error;
      if (error.code === 'service-failed') this.logger.warn(`The pod of "${service.slug}": ${error.message}`);
      throw new ServiceDispatchError(error.code, error.message);
    }
  }

  private inProcess(service: RegisteredService, request: DispatchRequest): Promise<ServiceResponse> {
    if (!service.runtime) throw new ServiceDispatchError('service-failed', 'The service could not be reached.');
    return service.runtime.dispatch(request);
  }

  private async overHttp(
    service: RegisteredService,
    pod: ServicePod,
    request: DispatchRequest
  ): Promise<ServiceResponse> {
    const gatewayKey = await this.keys.getEnvironmentToken(pod.projectEnvironmentId);
    if (!gatewayKey) {
      this.logger.error(`The pod of "${service.slug}" has no service key (${pod.projectEnvironmentId})`);
      throw new ServiceDispatchError('service-failed', 'The service could not be reached.');
    }
    const timeoutSeconds = handlerTimeoutSeconds(service.manifest, request.route, request.name) + HTTP_GRACE_SECONDS;
    let response: Response;
    let body: Uint8Array;
    try {
      response = await fetch(new URL(servicePath(request), pod.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [gatewayKeyHeader]: gatewayKey,
          ...(request.expectedManifestHash === undefined
            ? {}
            : { [expectedManifestHeader]: request.expectedManifestHash }),
        },
        body: JSON.stringify(request.body),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutSeconds * 1000)])
          : AbortSignal.timeout(timeoutSeconds * 1000),
      });
      body = await bodyWithin(response, GATE_RESPONSE_LIMIT);
    } catch (error) {
      if (error instanceof ResponseTooLarge) throw tooLarge();
      if ((error as Error).name === 'TimeoutError') {
        throw new ServiceDispatchError('timeout', `The service did not answer within ${timeoutSeconds} s.`);
      }
      this.logger.warn(`The pod of "${service.slug}" could not be reached: ${(error as Error).message}`);
      throw new ServiceDispatchError('service-failed', 'The service could not be reached.');
    }

    if (response.status === 503 && response.headers.get(manifestHeader) !== service.manifestHash) {
      throw new ServiceDispatchError(
        'service-reloading',
        `"${service.slug}" is reloading a new version; retry shortly.`
      );
    }
    if (response.status === 401 && request.route !== 'inbound') {
      this.logger.error(`The pod of "${service.slug}" refused the Gate's key for ${pod.projectEnvironmentId}`);
      throw new ServiceDispatchError('service-failed', 'The service refused the platform.');
    }
    if (
      request.route !== 'inbound' &&
      !SERVICE_ANSWER_STATUSES.has(response.status) &&
      !isOutOfBoundsRefusal(response.status, body)
    ) {
      this.logger.error(`The pod of "${service.slug}" answered ${response.status}, a status no service may use`);
      throw new ServiceDispatchError('service-failed', 'The service failed while handling this call.');
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  }
}
