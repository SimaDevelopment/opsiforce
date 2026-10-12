import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WireContext } from '@opsiforce/external-service-sdk/server';
import type { ConfigurationValues } from '../configuration/configuration-values';
import { configuredPublicUrl, webhookUrlOf } from '../configuration/webhook-url';
import type { RegisteredService } from '../registry/service-registry';

export interface DispatchContextFields {
  callId: string;
  caller?: WireContext['caller'];
  serviceConfiguration: ConfigurationValues;
}

@Injectable()
export class DispatchContexts {
  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    this.publicUrl = configuredPublicUrl(config);
  }

  of(service: RegisteredService, fields: DispatchContextFields): WireContext {
    return {
      callId: fields.callId,
      ...(fields.caller ? { caller: fields.caller } : {}),
      serviceConfiguration: fields.serviceConfiguration,
      webhookUrl: webhookUrlOf(this.publicUrl, service),
    };
  }
}
