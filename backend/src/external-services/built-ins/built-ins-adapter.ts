import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CallerIdentity, DefinedService, DeliveredEvent, DeliveryResult } from '@opsiforce/external-service-sdk';
import {
  createServicePipeline,
  mintCallerIdentity,
  nodeUpstreamTransport,
  unavailableServiceState,
  withAtomicUpdate,
  type ConfigurationSource,
  type EventDelivery,
  type IncomingCall,
  type ServicePipeline,
} from '@opsiforce/external-service-sdk/server';
import { SecretSealer } from '../../sealing/secret-sealer';
import { ConfigurationFetch } from '../configuration/configuration-fetch';
import { serviceWebhookUrl } from '../configuration/webhook-url';
import { EventDeliveries } from '../inbound/event-deliveries';
import { checkedEnvelope } from '../inbound/event-envelope';
import type { RegisteredService } from '../registry/service-registry';
import { builtInCallerKey } from './built-in-caller-key';
import { BuiltInRecords } from './built-in-records';
import { PUBLIC_API_SERVICE, PublicApiService } from './public-api-service';

export const BUILT_INS_ADAPTER_PATH = '/api/internal/external-services/built-ins';

export type AdaptedBuiltIn = RegisteredService & { defined: DefinedService };

const BUILT_IN_STATE = withAtomicUpdate(
  unavailableServiceState(
    'ctx.state is not available to built-in services: they run inside the platform, with no Project to keep it in'
  )
);

export function isAdaptedBuiltIn(service: RegisteredService): service is AdaptedBuiltIn {
  return service.origin === 'built_in' && service.defined !== null;
}

@Injectable()
export class BuiltInsAdapter {
  private readonly pipelines = new Map<string, ServicePipeline>();

  constructor(
    private readonly sealer: SecretSealer,
    private readonly configurations: ConfigurationFetch,
    private readonly deliveries: EventDeliveries,
    private readonly records: BuiltInRecords,
    private readonly config: ConfigService,
    private readonly publicApi: PublicApiService
  ) {}

  upstreamOf(service: AdaptedBuiltIn): string {
    return `${BUILT_INS_ADAPTER_PATH}/${service.slug}`;
  }

  mint(service: AdaptedBuiltIn, caller: CallerIdentity): string {
    return mintCallerIdentity(caller, this.keyOf(service));
  }

  keyOf(service: AdaptedBuiltIn): string {
    return builtInCallerKey(this.sealer, service.slug);
  }

  answer(service: AdaptedBuiltIn, call: IncomingCall): Promise<Response> {
    return this.pipelineOf(service).answer(call);
  }

  private pipelineOf(service: AdaptedBuiltIn): ServicePipeline {
    let pipeline = this.pipelines.get(service.id);
    if (!pipeline) {
      pipeline = createServicePipeline(this.definitionOf(service), {
        gatewayKey: this.keyOf(service),
        configurations: this.configurationSourceOf(service),
        upstreams: nodeUpstreamTransport,
        state: BUILT_IN_STATE,
        records: this.records.of(service),
        events: this.eventDeliveryOf(service),
        webhookUrl: this.webhookUrlOf(service),
      });
      this.pipelines.set(service.id, pipeline);
    }
    return pipeline;
  }

  private definitionOf(service: AdaptedBuiltIn): DefinedService {
    return service.slug === PUBLIC_API_SERVICE ? this.publicApi.definedFrom(service.defined) : service.defined;
  }

  private configurationSourceOf(service: AdaptedBuiltIn): ConfigurationSource {
    return {
      forCaller: (caller) =>
        this.configurations.forCopy(
          service,
          caller.projectEnvironmentId === undefined
            ? null
            : { tenantId: caller.tenantId, projectEnvironmentId: caller.projectEnvironmentId }
        ),
      service: async () => (await this.configurations.forCopy(service, null)).serviceConfiguration,
      projectConfigurations: () => this.configurations.projectConfigurationsOf(service),
    };
  }

  private eventDeliveryOf(service: AdaptedBuiltIn): EventDelivery {
    return {
      deliver: (event: DeliveredEvent, to: readonly string[]): Promise<DeliveryResult[]> => {
        const files = event.files ?? [];
        const reading = checkedEnvelope(
          service.manifest,
          {
            type: event.type,
            key: event.key,
            occurredAt: event.occurredAt,
            data: event.data,
            to: [...to],
            files: files.map((file, index) => ({ part: `file-${index}`, name: file.name, mimeType: file.mimeType })),
          },
          files.map((file, index) => ({
            field: `file-${index}`,
            filename: file.name,
            mimeType: file.mimeType,
            bytes: file.bytes,
          }))
        );
        if ('problems' in reading) {
          return Promise.reject(new Error(`the Event delivery answered 400: ${reading.problems.join('; ')}`));
        }
        return this.deliveries.deliver(service, reading.envelope);
      },
    };
  }

  private webhookUrlOf(service: AdaptedBuiltIn): string {
    try {
      return serviceWebhookUrl(this.config, service);
    } catch {
      return '';
    }
  }
}
