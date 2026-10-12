import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { problem } from '@opsiforce/external-service-sdk';
import {
  compileManifestValidators,
  findBoundSites,
  type ManifestValidators,
} from '@opsiforce/external-service-sdk/platform';
import type { DispatchRequest, ServiceResponse } from '@opsiforce/external-service-sdk/server';
import type { JsonValue } from '../../common/json';
import { ConfigurationDelivery } from '../configuration/configuration-delivery';
import { callersOwner, type ConfigurationValues } from '../configuration/configuration-values';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { Doorbell } from '../doorbell/doorbell';
import { checkServiceAnswer } from '../gate/answer-checks';
import { DispatchContexts } from '../gate/dispatch-contexts';
import { CallLog, type CallRecord } from '../gate/call-log';
import {
  answeredAndLogged,
  answeredProblem,
  dispatchedOrRefused,
  openedOrRefused,
  problemAnswer,
  type CallAnswer,
  type GateAnswer,
} from '../gate/service-answers';
import { DefaultMovedRefusal, refuse, refuseDisabledService, refuseUnconfiguredService } from '../gate/gate-refusals';
import { DefaultLaneMoved, ServiceDispatcher } from '../gate/service-dispatcher';
import { legacyMessageOf } from '../legacy/legacy-messages';
import { ExternalServiceStore, type EventToStore } from './external-service-store';
import type { RegisteredService } from '../registry/service-registry';
import { ExternalServiceUsageService } from '../usage/external-service-usage.service';
import { EventReceivers, type EventReceiver } from './event-receivers';
import type { InboundRequest } from './inbound-request';

export interface StoredEvents {
  service: string;
  projectEnvironmentId: string;
  envDirectory: string;
  eventIds: number[];
}

export interface InboundOutcome {
  answer: GateAnswer;
  stored: StoredEvents[];
  code?: string | null;
  moved?: boolean;
}

interface WireEvent {
  type: string;
  key: string;
  occurredAt: string;
  data: Record<string, unknown>;
  files?: { name: string; mimeType: string; base64: string }[];
}

interface WireInboundResult {
  events: WireEvent[];
  response?: { status?: number; headers?: Record<string, string>; body?: unknown };
}

interface Delivery {
  receiver: EventReceiver;
  events: EventToStore[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const providerContentTypes = new Set([
  'application/json',
  'application/problem+json',
  'application/xml',
  'text/plain',
  'text/xml',
]);

const reservedProviderHeaders = new Set([
  'x-content-type-options',
  'x-frame-options',
  'x-lighttpd-send-file',
  'x-powered-by',
  'x-real-ip',
  'x-xss-protection',
]);

const reservedProviderHeaderPrefixes = ['x-accel-', 'x-forwarded-', 'x-opsiforce-', 'x-original-', 'x-sendfile'];

function isPassableProviderHeader(lower: string): boolean {
  if (lower === 'retry-after') return true;
  if (!lower.startsWith('x-') || reservedProviderHeaders.has(lower)) return false;
  return !reservedProviderHeaderPrefixes.some((prefix) => lower.startsWith(prefix));
}

function providerContentType(value: string | undefined, fallback: string): string {
  const essence = value?.split(';')[0]?.trim().toLowerCase();
  return value !== undefined && essence !== undefined && providerContentTypes.has(essence) ? value : fallback;
}

function providerHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      const lower = name.toLowerCase();
      return isPassableProviderHeader(lower) ? [[lower, value]] : [];
    })
  );
}

function providerStatus(status: number | undefined): number {
  if (status === undefined) return 200;
  return status >= 300 && status < 400 ? 200 : status;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function providerAnswer(callId: string, response: WireInboundResult['response']): GateAnswer {
  if (!response) {
    return {
      callId,
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: encoder.encode(JSON.stringify({ received: true })),
    };
  }
  const declared = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const headers = providerHeaders(response.headers ?? {});
  let body = new Uint8Array();
  if (typeof response.body === 'string') {
    body = encoder.encode(response.body);
    headers['content-type'] = providerContentType(declared, 'text/plain; charset=utf-8');
  } else if (response.body !== undefined) {
    body = encoder.encode(JSON.stringify(response.body));
    headers['content-type'] = providerContentType(declared, 'application/json; charset=utf-8');
  }
  return { callId, status: providerStatus(response.status), headers, body };
}

function passedThrough(callId: string, response: ServiceResponse): GateAnswer {
  return {
    callId,
    status: providerStatus(response.status),
    headers: { 'content-type': providerContentType(response.headers['content-type'], 'text/plain; charset=utf-8') },
    body: response.body,
  };
}

function loggedOutcome(outcome: InboundOutcome): CallAnswer<InboundOutcome> {
  return { answer: outcome, status: outcome.answer.status, outputBytes: outcome.answer.body.byteLength };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

@Injectable()
export class InboundPipeline {
  private readonly logger = new Logger(InboundPipeline.name);
  private readonly validators = new Map<string, ManifestValidators>();
  private readonly storageMountPath: string;

  constructor(
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly delivery: ConfigurationDelivery,
    private readonly dispatcher: ServiceDispatcher,
    private readonly receivers: EventReceivers,
    private readonly store: ExternalServiceStore,
    private readonly callLog: CallLog,
    private readonly usage: ExternalServiceUsageService,
    private readonly contexts: DispatchContexts,
    private readonly doorbell: Doorbell,
    private readonly config: ConfigService
  ) {
    this.storageMountPath = this.config.getOrThrow<string>('storageMountPath');
  }

  async receive(service: RegisteredService, request: InboundRequest): Promise<InboundOutcome> {
    const call: CallRecord = {
      id: randomUUID(),
      kind: 'inbound',
      slug: service.slug,
      externalServiceId: service.id,
      manifestHash: service.manifestHash,
      tenantId: service.tenantId,
      serviceEnvironmentId: service.home?.environmentId ?? null,
      inputBytes: request.bytes,
      decision: 'refused',
      status: 0,
      durationMs: 0,
    };

    const outcome = await answeredAndLogged(this.callLog, call, {
      answer: async () => loggedOutcome(await this.verifyAndStore(service, request, call)),
      refused: (refusal, headers, cause) =>
        loggedOutcome({
          answer: problemAnswer(call.id, refusal, headers),
          stored: [],
          moved: cause instanceof DefaultMovedRefusal,
        }),
      failed: (error) => this.pipelineFailed(call.id, error),
    });
    return { ...outcome, code: call.code ?? null };
  }

  private async verifyAndStore(
    service: RegisteredService,
    request: InboundRequest,
    call: CallRecord
  ): Promise<InboundOutcome> {
    if (service.manifest.inbound !== true) {
      refuse({
        status: 404,
        code: 'no-inbound',
        detail: `"${service.slug}" does not receive webhooks.`,
        service: service.slug,
      });
    }
    if (service.home?.disabled) refuseDisabledService(service.slug);
    const serviceConfiguration = await this.serviceConfigurations.read(service, callersOwner(service));
    if (serviceConfiguration.missing.length > 0) refuseUnconfiguredService(service.slug);

    const opened = openedOrRefused(this.logger, call.id, service, () =>
      this.delivery.forInbound(service, callersOwner(service), serviceConfiguration.values)
    );
    const response = await dispatchedOrRefused(service, () =>
      this.dispatchedUnlessMoved(service, {
        route: 'inbound',
        body: {
          context: this.contexts.of(service, { callId: call.id, serviceConfiguration: opened.serviceConfiguration }),
          request: {
            method: request.method,
            headers: request.headers,
            query: request.query,
            rawBody: base64(request.rawBody),
            ...(request.fields === undefined ? {} : { body: request.fields }),
            files: request.files.map((file) => ({
              field: file.field,
              filename: file.filename,
              mimeType: file.mimeType,
              base64: base64(file.bytes),
            })),
          },
        },
      })
    );
    checkServiceAnswer({ callId: call.id, service, response, sentSecrets: opened.sentSecrets }, this.logger);

    if (response.status !== 200) {
      call.decision = response.status < 500 ? 'refused' : 'allowed';
      Object.assign(call, answeredProblem(response));
      return { answer: passedThrough(call.id, response), stored: [] };
    }

    call.decision = 'allowed';
    const result = JSON.parse(decoder.decode(response.body)) as WireInboundResult;
    call.operation = [...new Set(result.events.map((event) => event.type))].toSorted().join(', ') || null;
    return this.storeEvents(service, serviceConfiguration.values, result, call);
  }

  private async dispatchedUnlessMoved(service: RegisteredService, request: DispatchRequest): Promise<ServiceResponse> {
    try {
      return await this.dispatcher.dispatch(service, request);
    } catch (error) {
      if (error instanceof DefaultLaneMoved) throw new DefaultMovedRefusal(service.slug);
      throw error;
    }
  }

  private async storeEvents(
    service: RegisteredService,
    serviceConfiguration: ConfigurationValues,
    result: WireInboundResult,
    call: CallRecord
  ): Promise<InboundOutcome> {
    const invalid: string[] = [];
    const unmatched: string[] = [];
    const deliveries = new Map<string, Delivery>();
    const touched: JsonValue[] = [];

    for (const event of result.events) {
      const problemWithEvent = this.invalidity(service, event);
      if (problemWithEvent !== null) {
        this.logger.warn(`invalid_event: "${service.slug}" ${event.type} ${event.key}: ${problemWithEvent}`);
        invalid.push(`${event.type} ${problemWithEvent}`);
        continue;
      }
      const receivers = await this.receivers.of(service, event, serviceConfiguration);
      if (receivers.length === 0) {
        this.logger.log(`unmatched: "${service.slug}" ${event.type} ${event.key} reached no environment`);
        unmatched.push(event.type);
        continue;
      }
      touched.push(...(findBoundSites(service.manifest, { event: event.type }, event.data) as unknown as JsonValue[]));
      for (const receiver of receivers) {
        const delivery = deliveries.get(receiver.projectEnvironmentId) ?? { receiver, events: [] };
        delivery.events.push(toStore(event));
        deliveries.set(receiver.projectEnvironmentId, delivery);
      }
    }

    const stored: StoredEvents[] = [];
    let failedEnvironments = 0;
    for (const { receiver, events } of deliveries.values()) {
      const envDirectory = path.join(this.storageMountPath, receiver.directory);
      try {
        const eventIds = await this.store.storeEvents(envDirectory, service.slug, events, legacyMessageOf(service));
        stored.push({
          service: service.slug,
          projectEnvironmentId: receiver.projectEnvironmentId,
          envDirectory,
          eventIds,
        });
        await this.countStored(service.slug, receiver.projectEnvironmentId, eventIds.length);
      } catch (error) {
        failedEnvironments++;
        this.logger.error(
          `Could not store ${plural(events.length, 'Event')} of "${service.slug}" for environment ${receiver.projectEnvironmentId}`,
          (error as Error).stack
        );
      }
    }

    call.bounds = touched.length > 0 ? touched : null;
    const notes = [
      ...(invalid.length > 0 ? [`${plural(invalid.length, 'Event')} dropped as invalid_event (${invalid[0]})`] : []),
      ...(unmatched.length > 0 ? [`${plural(unmatched.length, 'Event')} unmatched`] : []),
    ];
    call.code = invalid.length > 0 ? 'invalid_event' : unmatched.length > 0 ? 'unmatched' : null;
    call.detail = notes.length > 0 ? `${notes.join('; ')}.` : null;

    if (!(await this.rang(service, stored))) {
      const unrung = problem({
        status: 503,
        code: 'doorbell-unavailable',
        detail: 'The Events were stored but the App could not be notified; send them again.',
      });
      call.code = unrung.code;
      call.detail = unrung.detail ?? null;
      return { answer: problemAnswer(call.id, unrung), stored };
    }

    if (failedEnvironments > 0) {
      call.code = 'event-store-failed';
      return {
        answer: problemAnswer(
          call.id,
          problem({
            status: 500,
            code: 'event-store-failed',
            detail: `The Events could not be stored for ${plural(failedEnvironments, 'environment')}; send them again.`,
          })
        ),
        stored,
      };
    }
    return { answer: providerAnswer(call.id, result.response), stored };
  }

  private async rang(service: RegisteredService, stored: readonly StoredEvents[]): Promise<boolean> {
    try {
      await this.doorbell.ringFor(service, stored);
      return true;
    } catch (error) {
      this.logger.error(`Could not queue the doorbell for "${service.slug}"`, (error as Error).stack);
      return false;
    }
  }

  private async countStored(slug: string, projectEnvironmentId: string, events: number): Promise<void> {
    try {
      await this.usage.countStoredEvents(projectEnvironmentId, slug, events);
    } catch (error) {
      this.logger.error(
        `Usage could not count ${plural(events, 'stored Event')} of "${slug}" for environment ${projectEnvironmentId}; the counter will undercount`,
        (error as Error).stack
      );
    }
  }

  private invalidity(service: RegisteredService, event: WireEvent): string | null {
    const validate = this.validatorsOf(service).events[event.type];
    if (!validate) return 'is not a declared Event type';
    if (Number.isNaN(Date.parse(event.occurredAt))) return 'has an occurredAt that is not a date';
    if (validate(event.data)) return null;
    const [error] = validate.errors ?? [];
    return `${error?.instancePath || '/'} ${error?.message ?? 'does not fit the declared data'}`;
  }

  private validatorsOf(service: RegisteredService): ManifestValidators {
    let validators = this.validators.get(service.manifestHash);
    if (!validators) {
      validators = compileManifestValidators(service.manifest);
      this.validators.set(service.manifestHash, validators);
    }
    return validators;
  }

  private pipelineFailed(callId: string, error: unknown) {
    this.logger.error(`Inbound call ${callId} failed in the platform`, (error as Error).stack);
    return problem({ status: 500, code: 'inbound-failed', detail: 'The platform failed while handling this webhook.' });
  }
}

function toStore(event: WireEvent): EventToStore {
  return {
    type: event.type,
    key: event.key,
    occurredAt: new Date(event.occurredAt).toISOString(),
    data: event.data,
    files: (event.files ?? []).map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      bytes: new Uint8Array(Buffer.from(file.base64, 'base64')),
    })),
  };
}
