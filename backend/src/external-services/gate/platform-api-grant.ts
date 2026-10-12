import type { AddressInfo } from 'node:net';
import { Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { WireContext } from '@opsiforce/external-service-sdk/server';
import { CallTokens } from '../../gateway/call-tokens';
import { PUBLIC_API_SERVICE } from '../configuration/operation-switches';
import type { RegisteredService } from '../registry/service-registry';
import type { GateCaller } from './gate-caller';
import { ServiceDispatcher } from './service-dispatcher';

export interface PlatformApiCall {
  callId: string;
  operation: string;
  caller: GateCaller;
}

export interface GrantedPlatformApi {
  contextFields: Required<Pick<WireContext, 'platformApi'>>;
  revoke: () => void;
}

@Injectable()
export class PlatformApiGrant {
  constructor(
    private readonly dispatcher: ServiceDispatcher,
    private readonly callTokens: CallTokens,
    private readonly httpAdapterHost: HttpAdapterHost
  ) {}

  grantFor(service: RegisteredService, call: PlatformApiCall): GrantedPlatformApi | null {
    if (service.slug !== PUBLIC_API_SERVICE || service.origin !== 'built_in') return null;
    if (!this.dispatcher.runsInProcess(service)) return null;
    const url = this.loopbackUrl();
    if (url === null) return null;
    const callToken = this.callTokens.issue({
      service: service.slug,
      callId: call.callId,
      operation: call.operation,
      tenantId: call.caller.tenantId,
      projectId: call.caller.projectId,
      projectEnvironmentId: call.caller.projectEnvironmentId,
    });
    return { contextFields: { platformApi: { url, token: callToken.token } }, revoke: callToken.revoke };
  }

  private loopbackUrl(): string | null {
    const address = this.httpAdapterHost.httpAdapter?.getHttpServer()?.address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') return null;
    const unspecified = ['0.0.0.0', '::', ''].includes(address.address);
    const host = unspecified ? '127.0.0.1' : address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }
}
