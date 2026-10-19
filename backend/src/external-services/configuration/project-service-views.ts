import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Field, ServiceManifest } from '@opsiforce/external-service-sdk';
import {
  infoTemplateVariablesOf,
  serviceConfigurationSourceOf,
  valueFieldsOf,
  type ServiceConfigurationSource,
} from '@opsiforce/external-service-sdk/platform';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, projectEnvironments, projects } from '../../../db/schema';
import { userIdOf } from './user-ids';
import { isProjectAccessible } from '../../project/project-visibility';
import { DeliveryService } from '../../delivery/delivery.service';
import { ServiceSkills } from '../knowledge/service-skills';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import type { HookFailure } from '../gate/hook-calls';
import { ConfigurationSaves } from './configuration-saves';
import { isListItem, masked, type ConfigurationValues } from './configuration-values';
import type { RevealedSecret } from './generated-values';
import { ProjectConfigurationSaveHooks } from './project-configuration-save-hooks';
import {
  ProjectConfigurationStore,
  storedShapeOf,
  type ProjectConfiguration,
  type ProjectConfigurationSave,
} from './project-configuration.store';
import type { RemovedItemsNotice } from './removed-items';
import { rotationTarget } from './rotation';
import { ServiceConfigurationStore } from './service-configuration.store';
import { ServiceConsumers } from './service-consumers';
import { summaryOf, type ServiceSummary } from './service-views';
import type { TolerantRead } from './tolerant-read';
import { serviceWebhookUrl } from './webhook-url';

export interface ProjectEnvironmentViewer {
  tenantId: string;
  keycloakId: string;
  projectId: string;
  projectEnvironmentId: string;
}

export interface ProjectConfigurationState {
  saved: boolean;
  missing: string[];
}

export type ProjectServiceState = 'enabled' | 'needs-configuration' | 'available';

export interface ProjectServiceSummary extends ServiceSummary {
  state: ProjectServiceState;
  configuration: ProjectConfigurationState;
}

export interface ProjectServiceList {
  agentId: string;
  services: ProjectServiceSummary[];
}

export interface ServiceConfigurationOption {
  value: string;
  label: string;
}

export interface ServiceConfigurationOptions {
  list: string;
  labelKey: string;
  options: ServiceConfigurationOption[];
}

export interface ProjectServiceView extends ServiceSummary {
  state: ProjectServiceState;
  manifest: Omit<ServiceManifest, 'serviceForm'>;
  projectConfiguration: ProjectConfiguration;
  serviceConfigurationOptions: ServiceConfigurationOptions[];
  templateValues: Record<string, string>;
  hookFailure: HookFailure | null;
  notice: RemovedItemsNotice | null;
}

export interface SavedProjectServiceView extends ProjectServiceView {
  revealed: RevealedSecret[];
}

export interface ProjectFormCallTarget {
  service: RegisteredService;
  serviceConfiguration: TolerantRead;
  projectConfiguration: ProjectConfiguration;
  tenantId: string;
  projectId: string;
  projectTitle: string | null;
  projectEnvironmentId: string;
  environment: string;
  userId: string | null;
}

interface ReachableProjectEnvironment {
  agentId: string;
  projectTitle: string | null;
  environment: string;
  userId: string;
}

function serviceConfigurationSourcesOf(form: readonly Field[]): ServiceConfigurationSource[] {
  const sources: ServiceConfigurationSource[] = [];
  for (const field of valueFieldsOf(form)) {
    if (field.type === 'list') sources.push(...serviceConfigurationSourcesOf(field.item));
    const source = serviceConfigurationSourceOf(field);
    if (!source) continue;
    const known = sources.some(
      (seen) => seen.serviceConfiguration === source.serviceConfiguration && seen.labelKey === source.labelKey
    );
    if (!known) sources.push(source);
  }
  return sources;
}

function optionLabel(item: ConfigurationValues & { id: string }, labelKey: string): string {
  const label = item[labelKey];
  return typeof label === 'string' || typeof label === 'number' ? String(label) : item.id;
}

function plainText(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
}

function templateValuesOf(
  service: RegisteredService,
  serviceConfiguration: TolerantRead,
  webhookUrl: () => string
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of infoTemplateVariablesOf(service.manifest.projectForm)) {
    if (variable === 'webhookUrl') values[variable] = webhookUrl();
    const serviceKey = /^serviceConfiguration\.(.+)$/.exec(variable)?.[1];
    const text = serviceKey === undefined ? null : plainText(serviceConfiguration.values[serviceKey]);
    if (text !== null) values[variable] = text;
  }
  return values;
}

function serviceConfigurationOptionsOf(
  service: RegisteredService,
  serviceConfiguration: TolerantRead
): ServiceConfigurationOptions[] {
  return serviceConfigurationSourcesOf(service.manifest.projectForm ?? []).map((source) => {
    const items = serviceConfiguration.values[source.serviceConfiguration];
    return {
      list: source.serviceConfiguration,
      labelKey: source.labelKey,
      options: (Array.isArray(items) ? items.filter(isListItem) : []).map((item) => ({
        value: item.id,
        label: optionLabel(item, source.labelKey),
      })),
    };
  });
}

function stateOf(configuration: ProjectConfiguration): ProjectConfigurationState {
  return { saved: configuration.saved, missing: configuration.missing };
}

function serviceStateOf(configuration: ProjectConfiguration, carriedByAgent: boolean): ProjectServiceState {
  if (configuration.saved) return 'enabled';
  return carriedByAgent ? 'needs-configuration' : 'available';
}

const STATE_ORDER: ProjectServiceState[] = ['enabled', 'needs-configuration', 'available'];

function byState(a: ProjectServiceSummary, b: ProjectServiceSummary): number {
  return STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.displayName.localeCompare(b.displayName);
}

function withMaskedSecrets(service: RegisteredService, configuration: ProjectConfiguration): ProjectConfiguration {
  return { ...configuration, values: masked(service.manifest.projectForm ?? [], configuration.values) };
}

@Injectable()
export class ProjectServiceViews {
  constructor(
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly projectConfigurationStore: ProjectConfigurationStore,
    private readonly serviceSkills: ServiceSkills,
    private readonly deliveries: DeliveryService,
    private readonly saveHooks: ProjectConfigurationSaveHooks,
    private readonly saves: ConfigurationSaves,
    private readonly consumers: ServiceConsumers,
    private readonly config: ConfigService
  ) {}

  async list(viewer: ProjectEnvironmentViewer): Promise<ProjectServiceList> {
    const { agentId } = await this.reachableProjectEnvironment(viewer);
    const carried = await this.servicesCarriedByAgent(viewer);
    const available = await this.availableServices(viewer);
    const services = await Promise.all(
      available.map(async ({ service }) => {
        const configuration = await this.projectConfigurationStore.read(service, viewer.projectEnvironmentId);
        return Object.assign(summaryOf(service), {
          state: serviceStateOf(configuration, carried.has(service.id)),
          configuration: stateOf(configuration),
        });
      })
    );
    return { agentId, services: services.toSorted(byState) };
  }

  async view(viewer: ProjectEnvironmentViewer, serviceId: string): Promise<ProjectServiceView> {
    await this.reachableProjectEnvironment(viewer);
    const { service, serviceConfiguration } = await this.availableService(viewer, serviceId);
    return this.viewOf(
      service,
      serviceConfiguration,
      await this.projectConfigurationStore.read(service, viewer.projectEnvironmentId),
      await this.servicesCarriedByAgent(viewer),
      await this.saveHooks.failureOf(service, viewer.projectEnvironmentId),
      await this.projectConfigurationStore.takeNotice(service, viewer.projectEnvironmentId)
    );
  }

  async save(viewer: ProjectEnvironmentViewer, serviceId: string, values: unknown): Promise<SavedProjectServiceView> {
    await this.reachableProjectEnvironment(viewer);
    const { service, serviceConfiguration } = await this.availableService(viewer, serviceId);
    return this.savedView(service, serviceConfiguration, viewer, () =>
      this.projectConfigurationStore.saveAndReport(service, viewer.projectEnvironmentId, values)
    );
  }

  async rotate(viewer: ProjectEnvironmentViewer, serviceId: string, target: unknown): Promise<SavedProjectServiceView> {
    await this.reachableProjectEnvironment(viewer);
    const { service, serviceConfiguration } = await this.availableService(viewer, serviceId);
    const current = await this.projectConfigurationStore.read(service, viewer.projectEnvironmentId);
    const rotate = rotationTarget(service.manifest.projectForm ?? [], current.values, target);
    return this.savedView(service, serviceConfiguration, viewer, () =>
      this.projectConfigurationStore.saveAndReport(service, viewer.projectEnvironmentId, storedShapeOf(current), {
        rotate,
      })
    );
  }

  async disconnect(viewer: ProjectEnvironmentViewer, serviceId: string): Promise<ProjectServiceView> {
    await this.reachableProjectEnvironment(viewer);
    const { service } = await this.availableService(viewer, serviceId);
    await this.consumers.disconnect(service.id, viewer.projectEnvironmentId);
    return this.view(viewer, serviceId);
  }

  async retryHook(viewer: ProjectEnvironmentViewer, serviceId: string): Promise<ProjectServiceView> {
    await this.reachableProjectEnvironment(viewer);
    const { service, serviceConfiguration } = await this.availableService(viewer, serviceId);
    const hookFailure = await this.saveHooks.retry(service, viewer.projectEnvironmentId);
    return this.viewOf(
      service,
      serviceConfiguration,
      await this.projectConfigurationStore.read(service, viewer.projectEnvironmentId),
      await this.servicesCarriedByAgent(viewer),
      hookFailure
    );
  }

  async discardHook(viewer: ProjectEnvironmentViewer, serviceId: string): Promise<ProjectServiceView> {
    await this.reachableProjectEnvironment(viewer);
    const { service, serviceConfiguration } = await this.availableService(viewer, serviceId);
    await this.saveHooks.discard(service, viewer.projectEnvironmentId);
    return this.viewOf(
      service,
      serviceConfiguration,
      await this.projectConfigurationStore.read(service, viewer.projectEnvironmentId),
      await this.servicesCarriedByAgent(viewer),
      null
    );
  }

  private async savedView(
    service: RegisteredService,
    serviceConfiguration: TolerantRead,
    viewer: ProjectEnvironmentViewer,
    save: () => Promise<ProjectConfigurationSave>
  ): Promise<SavedProjectServiceView> {
    const saved = await this.saves.project(service, viewer.projectEnvironmentId, save);
    const carried = await this.servicesCarriedByAgent(viewer);
    return {
      ...this.viewOf(service, serviceConfiguration, saved.current, carried, saved.hookFailure),
      revealed: saved.revealed,
    };
  }

  async formCallTarget(viewer: ProjectEnvironmentViewer, serviceId: string): Promise<ProjectFormCallTarget> {
    const reachable = await this.reachableProjectEnvironment(viewer);
    const { service, serviceConfiguration } = await this.availableService(viewer, serviceId);
    return {
      service,
      serviceConfiguration,
      projectConfiguration: await this.projectConfigurationStore.read(service, viewer.projectEnvironmentId),
      tenantId: viewer.tenantId,
      projectId: viewer.projectId,
      projectTitle: reachable.projectTitle,
      projectEnvironmentId: viewer.projectEnvironmentId,
      environment: reachable.environment,
      userId: reachable.userId,
    };
  }

  async assertCanOpen(viewer: ProjectEnvironmentViewer): Promise<void> {
    await this.reachableProjectEnvironment(viewer);
  }

  private async servicesCarriedByAgent(viewer: ProjectEnvironmentViewer): Promise<Set<string>> {
    return this.serviceSkills.servicesCarriedByAgentOf(
      await this.deliveries.serviceAudienceFor(viewer.projectEnvironmentId)
    );
  }

  private viewOf(
    service: RegisteredService,
    serviceConfiguration: TolerantRead,
    projectConfiguration: ProjectConfiguration,
    carried: ReadonlySet<string>,
    hookFailure: HookFailure | null,
    notice: RemovedItemsNotice | null = null
  ): ProjectServiceView {
    const { serviceForm: _serviceForm, ...manifest } = service.manifest;
    return {
      ...summaryOf(service),
      state: serviceStateOf(projectConfiguration, carried.has(service.id)),
      manifest,
      projectConfiguration: withMaskedSecrets(service, projectConfiguration),
      serviceConfigurationOptions: serviceConfigurationOptionsOf(service, serviceConfiguration),
      templateValues: templateValuesOf(service, serviceConfiguration, () => serviceWebhookUrl(this.config, service)),
      hookFailure,
      notice,
    };
  }

  private async availableServices(
    viewer: ProjectEnvironmentViewer
  ): Promise<{ service: RegisteredService; serviceConfiguration: TolerantRead }[]> {
    const services = (await this.registry.listForEnvironment(viewer.tenantId, viewer.projectEnvironmentId)).filter(
      (service) => !service.home?.disabled
    );
    const reads = await this.serviceConfigurations.readAllAsCallers(services);
    return services.flatMap((service) => {
      const serviceConfiguration = reads.get(service.id);
      return serviceConfiguration && serviceConfiguration.missing.length === 0
        ? [{ service, serviceConfiguration }]
        : [];
    });
  }

  private async availableService(
    viewer: ProjectEnvironmentViewer,
    serviceId: string
  ): Promise<{ service: RegisteredService; serviceConfiguration: TolerantRead }> {
    const found = (await this.availableServices(viewer)).find(({ service }) => service.id === serviceId);
    if (!found) throw new NotFoundException(`No External Service ${serviceId}`);
    return found;
  }

  private async reachableProjectEnvironment(viewer: ProjectEnvironmentViewer): Promise<ReachableProjectEnvironment> {
    const [row] = await db
      .select({ agentId: projects.agentId, projectTitle: projects.title, environment: environments.slug })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .where(
        and(
          eq(projectEnvironments.id, viewer.projectEnvironmentId),
          eq(projectEnvironments.projectId, viewer.projectId),
          eq(projects.tenantId, viewer.tenantId)
        )
      );
    const userId = await userIdOf(viewer.keycloakId);
    if (!row || !userId || !(await isProjectAccessible(viewer.tenantId, userId, viewer.projectId))) {
      throw new NotFoundException(`Project ${viewer.projectId} not found`);
    }
    return {
      agentId: row.agentId,
      projectTitle: row.projectTitle,
      environment: row.environment ?? 'default',
      userId,
    };
  }
}
