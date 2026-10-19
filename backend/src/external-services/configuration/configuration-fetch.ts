import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyCallerIdentity } from '@opsiforce/external-service-sdk/server';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceProjectConfigs, externalServices, projectEnvironments, projects } from '../../../db/schema';
import { GatewayKeyService } from '../../gateway/gateway-key.service';
import { GateCallers, NO_TENANT_CLAIM } from '../gate/gate-caller';
import { laneReceivers } from '../inbound/event-receivers';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { ConfigurationDelivery } from './configuration-delivery';
import { callersOwner, type ConfigurationValues } from './configuration-values';
import { ProjectConfigurationStore, projectConfigurationFromStored } from './project-configuration.store';
import { ServiceConfigurationStore } from './service-configuration.store';
import { configuredPublicUrl } from './webhook-url';

export interface FetchedConfiguration {
  serviceConfiguration: ConfigurationValues;
  projectConfiguration: ConfigurationValues | null;
  missing: { serviceForm: string[]; projectForm: string[] };
  settingsLink?: string;
}

export interface AskingEnvironment {
  tenantId: string;
  projectEnvironmentId: string;
}

export interface FetchedProjectConfiguration {
  projectId: string;
  projectEnvironmentId: string;
  projectConfiguration: ConfigurationValues;
}

export class ConfigurationFetchRefused extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string
  ) {
    super(message);
  }
}

export function settingsLinkOf(
  publicUrl: string,
  caller: { projectId: string; projectEnvironmentId: string },
  slug: string
): string {
  const link = `${publicUrl}/projects/${encodeURIComponent(caller.projectId)}?configure=${encodeURIComponent(slug)}`;
  return caller.projectEnvironmentId === caller.projectId
    ? link
    : `${link}&environment=${encodeURIComponent(caller.projectEnvironmentId)}`;
}

@Injectable()
export class ConfigurationFetch {
  private readonly publicUrl: string;

  constructor(
    config: ConfigService,
    private readonly keys: GatewayKeyService,
    private readonly callers: GateCallers,
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly projectConfigurations: ProjectConfigurationStore,
    private readonly delivery: ConfigurationDelivery
  ) {
    this.publicUrl = configuredPublicUrl(config);
  }

  async forPod(podKey: string | null, callerIdentity: string | undefined): Promise<FetchedConfiguration> {
    const copy = await this.copyOf(podKey);
    const projectEnvironmentId = this.callerOf(callerIdentity, podKey ?? '');
    return this.forCopy(
      copy,
      projectEnvironmentId === null ? null : { tenantId: copy.tenantId ?? NO_TENANT_CLAIM, projectEnvironmentId }
    );
  }

  async forCopy(copy: RegisteredService, asking: AskingEnvironment | null): Promise<FetchedConfiguration> {
    const caller =
      asking === null ? null : await this.callers.byProjectEnvironment(asking.tenantId, asking.projectEnvironmentId);
    if (asking !== null && !caller) {
      throw new ConfigurationFetchRefused(403, 'The Caller identity names no ProjectEnvironment of this Organization.');
    }

    const owner = callersOwner(copy);
    const serviceRead = await this.serviceConfigurations.read(copy, owner);
    const projectRead = caller ? await this.projectConfigurations.read(copy, caller.projectEnvironmentId) : null;
    const stored =
      caller && projectRead?.saved ? { projectEnvironmentId: caller.projectEnvironmentId, ...projectRead } : null;
    const opened = this.delivery.forFetch({
      service: copy,
      owner,
      serviceConfiguration: serviceRead.values,
      projectConfigurations: stored ? [stored] : [],
    });
    return {
      serviceConfiguration: opened.serviceConfiguration,
      projectConfiguration: opened.projectConfigurations[0]?.values ?? null,
      missing: { serviceForm: serviceRead.missing, projectForm: stored?.missing ?? [] },
      ...(caller ? { settingsLink: settingsLinkOf(this.publicUrl, caller, copy.slug) } : {}),
    };
  }

  async projectConfigurationsFor(podKey: string | null): Promise<FetchedProjectConfiguration[]> {
    return this.projectConfigurationsOf(await this.copyOf(podKey));
  }

  async projectConfigurationsOf(copy: RegisteredService): Promise<FetchedProjectConfiguration[]> {
    const rows = await db
      .select({
        projectId: projectEnvironments.projectId,
        projectEnvironmentId: externalServiceProjectConfigs.projectEnvironmentId,
        values: externalServiceProjectConfigs.values,
      })
      .from(externalServiceProjectConfigs)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceProjectConfigs.projectEnvironmentId))
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(and(eq(externalServiceProjectConfigs.externalServiceId, copy.id), ...laneReceivers(copy)));
    const opened = this.delivery.forFetch({
      service: copy,
      owner: callersOwner(copy),
      serviceConfiguration: {},
      projectConfigurations: rows.map((row) => ({
        projectEnvironmentId: row.projectEnvironmentId,
        values: projectConfigurationFromStored(copy, row.values).values,
      })),
    });
    return rows.map((row, index) => ({
      projectId: row.projectId,
      projectEnvironmentId: row.projectEnvironmentId,
      projectConfiguration: opened.projectConfigurations[index]?.values ?? {},
    }));
  }

  callerOf(callerIdentity: string | undefined, podKey: string): string | null {
    if (callerIdentity === undefined || callerIdentity === '') return null;
    const caller = verifyCallerIdentity(callerIdentity, podKey);
    if (!caller) throw new ConfigurationFetchRefused(401, 'The Caller identity is not valid for this pod.');
    return caller.projectEnvironmentId ?? null;
  }

  async copyOf(podKey: string | null): Promise<RegisteredService> {
    const identity = podKey === null ? null : await this.keys.validateToken(podKey);
    if (!identity?.projectEnvironmentId || !identity.tenantId) {
      throw new ConfigurationFetchRefused(401, "Send the pod's Gateway Key: Authorization: Bearer gw-…");
    }
    const [row] = await db
      .select({
        id: externalServices.id,
        isDevelopment: projectEnvironments.isDefault,
        environmentId: projectEnvironments.environmentId,
      })
      .from(externalServices)
      .innerJoin(projectEnvironments, eq(projectEnvironments.projectId, externalServices.builderChatId))
      .where(
        and(
          eq(projectEnvironments.id, identity.projectEnvironmentId),
          eq(externalServices.tenantId, identity.tenantId),
          eq(externalServices.origin, 'custom')
        )
      );
    const copy = !row
      ? null
      : row.isDevelopment
        ? await servableOrNone(this.registry.development(row.id))
        : row.environmentId
          ? await servableOrNone(this.registry.publishedAt(row.id, row.environmentId))
          : null;
    if (!copy) throw new ConfigurationFetchRefused(403, 'This Gateway Key belongs to no copy of an External Service.');
    return copy;
  }
}
