import { Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, externalServiceProjectConfigs, projectEnvironments, projects } from '../../../db/schema';
import { errorMessage } from '../../common/error-message';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { ProjectConfigurationSaveHooks } from './project-configuration-save-hooks';
import { ProjectConfigurationStore } from './project-configuration.store';

export interface ServiceConsumer {
  projectId: string;
  projectTitle: string | null;
  projectEnvironmentId: string;
  environmentName: string | null;
}

@Injectable()
export class ServiceConsumers {
  private readonly logger = new Logger(ServiceConsumers.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly store: ProjectConfigurationStore,
    private readonly saveHooks: ProjectConfigurationSaveHooks
  ) {}

  of(serviceId: string): Promise<ServiceConsumer[]> {
    return db
      .select({
        projectId: projects.id,
        projectTitle: projects.title,
        projectEnvironmentId: projectEnvironments.id,
        environmentName: environments.name,
      })
      .from(externalServiceProjectConfigs)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceProjectConfigs.projectEnvironmentId))
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .where(eq(externalServiceProjectConfigs.externalServiceId, serviceId))
      .orderBy(asc(projects.title), asc(environments.name));
  }

  async sayGoodbye(serviceId: string): Promise<void> {
    const consumers = await this.of(serviceId);
    this.logger.log(`Saying goodbye to ${consumers.length} consumer(s) of ${serviceId} before it is deleted`);
    const notStarting = new Set<string>();
    for (const consumer of consumers) {
      const service = await this.servingLaneOf(consumer.projectEnvironmentId, serviceId);
      if (!service) continue;
      const lane = service.home?.projectEnvironmentId ?? service.id;
      if (notStarting.has(lane)) {
        this.logger.warn(`No goodbye for ${consumer.projectEnvironmentId}: ${service.slug}'s pod did not start`);
        await this.store.forget(service, consumer.projectEnvironmentId);
        continue;
      }
      if ((await this.sayGoodbyeTo(service, consumer.projectEnvironmentId)) === 'service-starting')
        notStarting.add(lane);
    }
  }

  async sayGoodbyeIn(projectEnvironmentId: string): Promise<void> {
    for (const serviceId of await this.store.configuredServiceIds(projectEnvironmentId)) {
      const service = await this.servingLaneOf(projectEnvironmentId, serviceId);
      if (service) await this.sayGoodbyeTo(service, projectEnvironmentId);
    }
  }

  private async sayGoodbyeTo(service: RegisteredService, projectEnvironmentId: string): Promise<string | null> {
    try {
      const previous = await this.store.read(service, projectEnvironmentId);
      if (previous.missing.length > 0) return null;
      const failure = await this.saveHooks.saved(service, projectEnvironmentId, { previous, current: null });
      if (failure)
        this.warnGoodbyeFailed(
          service,
          projectEnvironmentId,
          `${failure.code}${failure.detail ? `: ${failure.detail}` : ''}`
        );
      return failure?.code ?? null;
    } catch (err) {
      this.warnGoodbyeFailed(service, projectEnvironmentId, errorMessage(err));
      return null;
    } finally {
      await this.store.forget(service, projectEnvironmentId);
    }
  }

  private warnGoodbyeFailed(service: RegisteredService, projectEnvironmentId: string, reason: string): void {
    this.logger.warn(
      `The ${service.slug} save hook for ${projectEnvironmentId} failed before its configuration was deleted: ${reason}`
    );
  }

  private async servingLaneOf(projectEnvironmentId: string, serviceId: string): Promise<RegisteredService | null> {
    const service = await servableOrNone(this.registry.byIdForEnvironment(projectEnvironmentId, serviceId), (error) =>
      this.logger.warn(`No goodbye for ${projectEnvironmentId}: ${error.slug} cannot be served: ${error.message}`)
    );
    if (!service) return null;
    if (service.home?.disabled) {
      this.logger.warn(`No goodbye for ${projectEnvironmentId}: ${service.slug} is disabled`);
      return null;
    }
    return service;
  }
}
