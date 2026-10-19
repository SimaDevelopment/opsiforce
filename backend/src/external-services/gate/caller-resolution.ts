import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CallerIdentity } from '@opsiforce/external-service-sdk';
import { mintCallerIdentity } from '@opsiforce/external-service-sdk/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projects } from '../../../db/schema';
import { GatewayKeyService } from '../../gateway/gateway-key.service';
import { BuiltInsAdapter, isAdaptedBuiltIn } from '../built-ins/built-ins-adapter';
import { GateCallers, platformCallerOf, type GateCaller } from './gate-caller';
import { DefaultLaneHolds } from './default-lane-holds';
import { SERVICE_START_HOLD_MS, ServicePods, UnreachablePod, type ServicePod } from './service-pods';
import { UnservableCustomService } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { gatewayKeyIn } from './gateway-key-in';

export type ServedBy = 'pod' | 'built-in';

interface Forwarding {
  servedBy: ServedBy;
  upstream: string;
  callerIdentity: string;
}

export interface ResolvedCaller extends Forwarding {
  status: 200;
  tenantId: string;
  serviceId: string;
}

export interface ResolvedWebhook extends Forwarding {
  status: 200;
  tenantId: string | null;
  serviceId: string;
  slug: string;
}

export interface RefusedCaller {
  status: 401 | 404 | 502 | 504;
  message: string;
}

export type CallerResolution = ResolvedCaller | RefusedCaller;

export type WebhookResolution = ResolvedWebhook | RefusedCaller;

class Refused extends Error {
  constructor(
    readonly status: RefusedCaller['status'],
    message: string
  ) {
    super(message);
  }
}

const sdk1Note = 'built on SDK 1 and must be rebuilt on SDK 2 or deleted';

function turnedOff(service: Pick<RegisteredService, 'manifest'>): Refused {
  return new Refused(404, `${service.manifest.displayName} is turned off in this Organization.`);
}

interface UnservableWording {
  subject: string;
  turnedOff: string;
}

function refusalOfUnservable(error: unknown, wording: UnservableWording): Refused {
  if (!(error instanceof UnservableCustomService)) throw error;
  if (error.disabled) return new Refused(404, wording.turnedOff);
  const subject = `${wording.subject.charAt(0).toUpperCase()}${wording.subject.slice(1)}`;
  if (error.builtOnSdk1) return new Refused(404, `${subject} is ${sdk1Note}.`);
  return new Refused(502, `The files of ${wording.subject} cannot be served: ${error.message}`);
}

function refuseWithoutWebhooks(service: RegisteredService): void {
  if (service.manifest.inbound !== true) {
    throw new Refused(404, `${service.manifest.displayName} does not receive webhooks.`);
  }
}

async function isProjectDisabled(projectId: string): Promise<boolean> {
  const [row] = await db.select({ disabled: projects.disabled }).from(projects).where(eq(projects.id, projectId));
  return row?.disabled ?? true;
}

@Injectable()
export class CallerResolutions {
  private readonly logger = new Logger(CallerResolutions.name);

  constructor(
    private readonly keys: GatewayKeyService,
    private readonly callers: GateCallers,
    private readonly registry: ServiceRegistry,
    private readonly pods: ServicePods,
    private readonly holds: DefaultLaneHolds,
    private readonly builtIns: BuiltInsAdapter,
    @Inject(SERVICE_START_HOLD_MS) private readonly startHoldMs: number
  ) {}

  async resolveWebhook(serviceIdOrSlug: string, development: boolean): Promise<WebhookResolution> {
    try {
      const service = await this.afterAnySwitch(await this.webhookServiceOf(serviceIdOrSlug, development), () =>
        this.webhookServiceOf(serviceIdOrSlug, development)
      );
      refuseWithoutWebhooks(service);
      return {
        status: 200,
        ...(await this.forwardingTo(service, platformCallerOf(service.tenantId))),
        tenantId: service.tenantId,
        serviceId: service.id,
        slug: service.slug,
      };
    } catch (error) {
      if (error instanceof Refused) return { status: error.status, message: error.message };
      throw error;
    }
  }

  async resolve(credential: string | undefined, slug: string): Promise<CallerResolution> {
    try {
      const caller = await this.callerOf(credential);
      const service = await this.afterAnySwitch(await this.serviceFor(caller, slug), () =>
        this.serviceFor(caller, slug)
      );
      const identity: CallerIdentity = {
        kind: 'call',
        tenantId: caller.tenantId,
        projectId: caller.projectId,
        projectEnvironmentId: caller.projectEnvironmentId,
        environment: caller.environment,
      };
      return {
        status: 200,
        ...(await this.forwardingTo(service, identity)),
        tenantId: caller.tenantId,
        serviceId: service.id,
      };
    } catch (error) {
      if (error instanceof Refused) return { status: error.status, message: error.message };
      throw error;
    }
  }

  private async forwardingTo(service: RegisteredService, identity: CallerIdentity): Promise<Forwarding> {
    if (isAdaptedBuiltIn(service)) {
      return {
        servedBy: 'built-in',
        upstream: this.builtIns.upstreamOf(service),
        callerIdentity: this.builtIns.mint(service, identity),
      };
    }
    if (service.home?.disabled) throw turnedOff(service);
    const pod = await this.podOf(service);
    return {
      servedBy: 'pod',
      upstream: pod.url,
      callerIdentity: mintCallerIdentity(identity, await this.receivingKeyOf(service, pod)),
    };
  }

  private async receivingKeyOf(service: RegisteredService, pod: ServicePod): Promise<string> {
    const receivingKey = await this.keys.getEnvironmentToken(pod.projectEnvironmentId);
    if (!receivingKey) {
      this.logger.error(`The pod of "${service.slug}" has no Gateway Key (${pod.projectEnvironmentId})`);
      throw new Refused(502, `${service.manifest.displayName} could not be reached.`);
    }
    return receivingKey;
  }

  private async webhookServiceOf(serviceIdOrSlug: string, development: boolean): Promise<RegisteredService> {
    let service: RegisteredService | null | undefined;
    try {
      service = development
        ? await this.registry.development(serviceIdOrSlug)
        : await this.registry.webhookTarget(serviceIdOrSlug);
    } catch (error) {
      throw refusalOfUnservable(error, {
        subject: 'this External Service',
        turnedOff: 'This External Service is turned off in its Organization.',
      });
    }
    if (!service) throw new Refused(404, 'There is no External Service at this Webhook address.');
    return service;
  }

  private async callerOf(credential: string | undefined): Promise<GateCaller> {
    const key = gatewayKeyIn(credential);
    if (key === null) throw new Refused(401, 'Send your Gateway Key (gw-…) in a request header.');
    const identity = await this.keys.validateToken(key);
    const caller =
      identity?.tenantId && identity.projectEnvironmentId
        ? await this.callers.byProjectEnvironment(identity.tenantId, identity.projectEnvironmentId)
        : null;
    if (!caller) throw new Refused(401, 'This Gateway Key is unknown or revoked.');
    if (await isProjectDisabled(caller.projectId)) {
      throw new Refused(401, "This Gateway Key's Project is disabled.");
    }
    return caller;
  }

  private async serviceFor(caller: GateCaller, slug: string): Promise<RegisteredService> {
    let service: RegisteredService | undefined;
    try {
      service = await this.registry.forEnvironment(caller.tenantId, caller.projectEnvironmentId, slug);
    } catch (error) {
      throw refusalOfUnservable(error, {
        subject: `"${slug}"`,
        turnedOff: `${slug} is turned off in this Organization.`,
      });
    }
    if (!service) throw new Refused(404, `There is no External Service "${slug}" in this Organization.`);
    return service;
  }

  private async afterAnySwitch(
    service: RegisteredService,
    again: () => Promise<RegisteredService>
  ): Promise<RegisteredService> {
    if (service.home?.lane !== 'default' || !this.holds.isHeld(service.id)) return service;
    if (!(await this.holds.released(service.id, this.startHoldMs))) {
      throw new Refused(504, `${service.manifest.displayName} is switching its Default environment; retry shortly.`);
    }
    return again();
  }

  private async podOf(service: RegisteredService): Promise<ServicePod> {
    if (!service.home) throw new Refused(404, `"${service.slug}" has no pod.`);
    try {
      return await this.pods.reach(service.home);
    } catch (error) {
      if (!(error instanceof UnreachablePod)) throw error;
      if (error.code === 'service-disabled') throw turnedOff(service);
      if (error.code === 'service-failed') {
        throw new Refused(502, `${service.manifest.displayName} couldn't start.`);
      }
      throw new Refused(504, `${service.manifest.displayName} did not start in time; retry shortly.`);
    }
  }
}
