import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProblemDetails } from '@opsiforce/external-service-sdk';
import { PROBLEM_CONTENT_TYPE } from '../http/problem-reply';
import { callersOwner } from '../configuration/configuration-values';
import { ProjectConfigurationStore } from '../configuration/project-configuration.store';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { serviceWebhookUrl } from '../configuration/webhook-url';
import type { TolerantRead } from '../configuration/tolerant-read';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../public-api/pagination';
import { CallLog } from './call-log';
import { GateCallers, type GateCaller, type GateCallerSource } from './gate-caller';
import { resolveCallable } from './callable-service';
import { GateRefusal, refuse, refuseUnconfiguredService, refuseUnknownCaller } from './gate-refusals';
import { describeService } from './service-description';
import { serviceOpenApiDocument, type ServiceOpenApiDocument } from './service-openapi';

export interface SurfaceAnswer {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

interface AvailableService {
  caller: GateCaller;
  service: RegisteredService;
  serviceConfiguration: TolerantRead;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function json(body: unknown, headers: Record<string, string> = {}): SurfaceAnswer {
  return { status: 200, headers: { 'content-type': JSON_CONTENT_TYPE, ...headers }, body };
}

function problemSurface(problem: ProblemDetails): SurfaceAnswer {
  return { status: problem.status, headers: { 'content-type': PROBLEM_CONTENT_TYPE }, body: problem };
}

function entityTagOf(manifestHash: string): string {
  return `"${manifestHash}"`;
}

function matchesEntityTag(ifNoneMatch: string | undefined, entityTag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === entityTag);
}

function callLimitOf(limit: string | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  const value = Number(limit);
  if (!/^\d+$/.test(limit) || value < 1 || value > MAX_PAGE_LIMIT) {
    refuse({
      status: 400,
      code: 'invalid-limit',
      detail: `limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}.`,
    });
  }
  return value;
}

@Injectable()
export class GateSurfaces {
  private readonly documents = new Map<string, ServiceOpenApiDocument>();

  constructor(
    private readonly callers: GateCallers,
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly projectConfigurationStore: ProjectConfigurationStore,
    private readonly callLog: CallLog,
    private readonly config: ConfigService
  ) {}

  describe(from: GateCallerSource, slug: string): Promise<SurfaceAnswer> {
    return this.answer(async () => {
      const { caller, service, serviceConfiguration } = await this.availableService(from, slug);
      const projectConfiguration = await this.projectConfigurationStore.read(service, caller.projectEnvironmentId);
      return json(
        describeService({
          service,
          caller,
          projectConfiguration,
          serviceConfiguration: serviceConfiguration.values,
          webhookUrl: serviceWebhookUrl(this.config, service),
        })
      );
    });
  }

  openApi(from: GateCallerSource, slug: string, ifNoneMatch: string | undefined): Promise<SurfaceAnswer> {
    return this.answer(async () => {
      const { service } = await this.availableService(from, slug);
      const entityTag = entityTagOf(service.manifestHash);
      const cacheHeaders = { etag: entityTag, 'cache-control': 'private, no-cache' };
      if (matchesEntityTag(ifNoneMatch, entityTag)) return { status: 304, headers: cacheHeaders };
      return json(this.documentOf(service), cacheHeaders);
    });
  }

  recentCalls(from: GateCallerSource, slug: string, limit: string | undefined): Promise<SurfaceAnswer> {
    return this.answer(async () => {
      const caller = await this.callers.resolve(from);
      if (!caller) refuseUnknownCaller();
      const service = await resolveCallable(this.registry, caller, slug);
      const calls = await this.callLog.recentFor({
        projectEnvironmentId: caller.projectEnvironmentId,
        externalServiceId: service.id,
        limit: callLimitOf(limit),
      });
      return json({ calls });
    });
  }

  private documentOf(service: RegisteredService): ServiceOpenApiDocument {
    let document = this.documents.get(service.manifestHash);
    if (!document) {
      document = serviceOpenApiDocument(service);
      this.documents.set(service.manifestHash, document);
    }
    return document;
  }

  private async availableService(from: GateCallerSource, slug: string): Promise<AvailableService> {
    const caller = await this.callers.resolve(from);
    if (!caller) refuseUnknownCaller();
    const service = await resolveCallable(this.registry, caller, slug);
    const serviceConfiguration = await this.serviceConfigurations.read(service, callersOwner(service));
    if (serviceConfiguration.missing.length > 0) refuseUnconfiguredService(slug);
    return { caller, service, serviceConfiguration };
  }

  private async answer(build: () => Promise<SurfaceAnswer>): Promise<SurfaceAnswer> {
    try {
      return await build();
    } catch (error) {
      if (error instanceof GateRefusal) return problemSurface(error.refusal);
      throw error;
    }
  }
}
