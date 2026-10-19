import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices, projectEnvironments, projects } from '../../../db/schema';
import { GatewayKeyService } from '../../gateway/gateway-key.service';
import { ProjectService } from '../../project/project.service';
import { TEST_PROJECT_KIND } from '../../project/project.types';
import { masked, type ConfigurationValues } from '../configuration/configuration-values';
import { ConfigurationSaves } from '../configuration/configuration-saves';
import type { RevealedSecret } from '../configuration/generated-values';
import { ProjectConfigurationStore, type ProjectConfiguration } from '../configuration/project-configuration.store';
import type { ProjectFormCallTarget } from '../configuration/project-service-views';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { serviceWebhookUrl } from '../configuration/webhook-url';
import { GateCallers } from '../gate/gate-caller';
import { refuse, refuseUnconfiguredService, refuseUnknownCaller } from '../gate/gate-refusals';
import { ExternalServiceStore, type StoredEvent } from '../inbound/external-service-store';
import { UnservableCustomService } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';

const BUILDER_LANE_EVENTS_LIMIT = 50;

const BUILDER_LANE_MAX_EVENTS = 200;

export interface BuilderChat {
  serviceId: string;
  slug: string;
  name: string;
  tenantId: string;
  chatId: string;
  createdBy: string | null;
  published: boolean;
  disabled: boolean;
}

export interface TestProjectView {
  id: string;
  projectEnvironmentId: string;
  agentId: string;
  title: string | null;
  status: string;
  disabled: boolean;
}

export interface BuilderLaneView {
  service: {
    id: string;
    slug: string;
    name: string;
    published: boolean;
    disabled: boolean;
    serviceHost: string | null;
  };
  development: {
    webhookUrl: string | null;
    servable: boolean;
    problem: string | null;
    serviceConfiguration: { saved: boolean; values: ConfigurationValues; missing: string[] };
  };
  testProject: (TestProjectView & { gatewayKey: string | null }) | null;
}

export interface TestProjectConfigurationView {
  service: string;
  projectConfiguration: ProjectConfiguration | Pick<ProjectConfiguration, 'saved' | 'values' | 'missing'>;
}

export interface SavedTestProjectConfigurationView extends TestProjectConfigurationView {
  revealed: RevealedSecret[];
}

@Injectable()
export class BuilderLane {
  private readonly storageMountPath: string;

  constructor(
    private readonly keys: GatewayKeyService,
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly projectConfigurationStore: ProjectConfigurationStore,
    private readonly saves: ConfigurationSaves,
    private readonly callers: GateCallers,
    private readonly store: ExternalServiceStore,
    private readonly projectService: ProjectService,
    private readonly config: ConfigService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async chatOf(serviceKey: string | null): Promise<BuilderChat> {
    const identity = serviceKey === null ? null : await this.keys.validateToken(serviceKey);
    if (!identity?.projectEnvironmentId || !identity.tenantId) refuseUnknownCaller();
    const [row] = await db
      .select({
        serviceId: externalServices.id,
        slug: externalServices.slug,
        tenantId: externalServices.tenantId,
        defaultEnvironmentId: externalServices.defaultEnvironmentId,
        chatId: projects.id,
        title: projects.title,
        createdBy: projects.createdBy,
        disabled: projects.disabled,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .innerJoin(externalServices, eq(externalServices.builderChatId, projects.id))
      .where(and(eq(projectEnvironments.id, identity.projectEnvironmentId), eq(projectEnvironments.isDefault, true)));
    if (!row || row.tenantId !== identity.tenantId) {
      refuse({
        status: 403,
        code: 'not-a-builder-chat',
        detail: "Only an External Service builder chat's Development may use these routes.",
      });
    }
    return {
      serviceId: row.serviceId,
      slug: row.slug,
      name: row.title ?? row.slug,
      tenantId: row.tenantId,
      chatId: row.chatId,
      createdBy: row.createdBy,
      published: row.defaultEnvironmentId !== null,
      disabled: row.disabled,
    };
  }

  async view(chat: BuilderChat): Promise<BuilderLaneView> {
    const development = await this.developmentOrProblem(chat);
    const read =
      development.service &&
      (await this.serviceConfigurations.read(development.service, {
        tenantId: chat.tenantId,
        environment: 'development',
      }));
    const stored = development.service ? await this.serviceConfigurations.storedEnvironments(development.service) : [];
    const testProject = await this.testProjectOf(chat);
    return {
      service: {
        id: chat.serviceId,
        slug: chat.slug,
        name: chat.name,
        published: chat.published,
        disabled: chat.disabled,
        serviceHost: this.serviceHostOf(chat.slug),
      },
      development: {
        webhookUrl: serviceWebhookUrl(this.config, {
          id: chat.serviceId,
          slug: chat.slug,
          origin: 'custom',
          home: { lane: 'development' },
        }),
        servable: development.service !== null,
        problem: development.problem,
        serviceConfiguration: {
          saved: stored.includes('development'),
          values:
            read && development.service ? masked(development.service.manifest.serviceForm ?? [], read.values) : {},
          missing: read ? read.missing : [],
        },
      },
      testProject: testProject && {
        ...testProject,
        gatewayKey: await this.keys.getEnvironmentToken(testProject.projectEnvironmentId),
      },
    };
  }

  async createTestProject(chat: BuilderChat, body: { agentId?: unknown; title?: unknown }): Promise<TestProjectView> {
    const existing = await this.testProjectOf(chat);
    if (existing) this.refuseSecondTestProject(existing);
    if (body.agentId !== undefined && typeof body.agentId !== 'string') {
      refuse({ status: 400, code: 'invalid-agent', detail: 'agentId must be a string.' });
    }
    const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : `${chat.name} test`;
    const created = await this.projectService.create(
      { title, ...(typeof body.agentId === 'string' ? { agentId: body.agentId } : {}) },
      chat.tenantId,
      { kind: TEST_PROJECT_KIND, createdBy: chat.createdBy, createdByProjectId: chat.chatId }
    );
    const first = await this.testProjectOf(chat);
    if (first && first.id !== created.id) {
      await this.projectService.discardHalfCreatedProject(created.id);
      this.refuseSecondTestProject(first);
    }
    if (!first)
      refuse({ status: 500, code: 'test-project-missing', detail: 'The Test Project vanished right after creation.' });
    return first;
  }

  async update(chat: BuilderChat): Promise<void> {
    const testProject = await this.requireTestProject(chat);
    await this.projectService.updateTestProject(testProject.id);
  }

  async reset(chat: BuilderChat): Promise<void> {
    const testProject = await this.requireTestProject(chat);
    if (testProject.disabled) {
      refuse({
        status: 423,
        code: 'test-project-disabled',
        detail: 'The Test Project is disabled; a human enables it from its pane.',
      });
    }
    await this.projectService.resetTestProject(testProject.id);
  }

  async configuration(chat: BuilderChat): Promise<TestProjectConfigurationView> {
    const { testProject, development } = await this.testLane(chat);
    return this.configurationView(
      development,
      await this.projectConfigurationStore.read(development, testProject.projectEnvironmentId)
    );
  }

  async saveConfiguration(chat: BuilderChat, values: unknown): Promise<SavedTestProjectConfigurationView> {
    const { testProject, development } = await this.testLane(chat);
    const saved = await this.saves.project(development, testProject.projectEnvironmentId, () =>
      this.projectConfigurationStore.saveAndReport(development, testProject.projectEnvironmentId, values)
    );
    return { ...this.configurationView(development, saved.current), revealed: saved.revealed };
  }

  async formCallTarget(chat: BuilderChat): Promise<ProjectFormCallTarget> {
    const { testProject, development } = await this.testLane(chat);
    const caller = await this.callers.byProjectEnvironment(chat.tenantId, testProject.projectEnvironmentId);
    if (!caller) this.refuseNoTestProject();
    const serviceConfiguration = (await this.serviceConfigurations.readAllAsCallers([development])).get(development.id);
    if (!serviceConfiguration) refuseUnconfiguredService(development);
    return {
      service: development,
      serviceConfiguration,
      projectConfiguration: await this.projectConfigurationStore.read(development, testProject.projectEnvironmentId),
      tenantId: caller.tenantId,
      projectId: caller.projectId,
      projectTitle: caller.projectTitle,
      projectEnvironmentId: caller.projectEnvironmentId,
      environment: caller.environment,
      userId: null,
    };
  }

  async events(chat: BuilderChat, limit: string | undefined): Promise<{ events: StoredEvent[] }> {
    const testProject = await this.requireTestProject(chat);
    const [environment] = await db
      .select({ directory: projectEnvironments.directory })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, testProject.projectEnvironmentId));
    if (!environment) this.refuseNoTestProject();
    return {
      events: await this.store.recentEvents(
        path.join(this.storageMountPath, environment.directory),
        chat.slug,
        eventLimitOf(limit)
      ),
    };
  }

  async servableDevelopment(chat: BuilderChat): Promise<RegisteredService> {
    const development = await this.developmentOrProblem(chat);
    if (!development.service) {
      refuse({
        status: 409,
        code: 'development-unservable',
        detail: `Development's service.json cannot be served yet: ${development.problem}`,
      });
    }
    return development.service;
  }

  private configurationView(
    development: RegisteredService,
    configuration: ProjectConfiguration
  ): TestProjectConfigurationView {
    const values = masked(development.manifest.projectForm ?? [], configuration.values);
    return {
      service: development.slug,
      projectConfiguration: { saved: configuration.saved, values, missing: configuration.missing },
    };
  }

  private async testLane(chat: BuilderChat): Promise<{ testProject: TestProjectView; development: RegisteredService }> {
    const testProject = await this.requireTestProject(chat);
    return { testProject, development: await this.servableDevelopment(chat) };
  }

  private serviceHostOf(slug: string): string | null {
    const externalServicesHost = this.config.get<string>('externalServicesHost', '');
    return externalServicesHost === '' ? null : `https://${slug}.${externalServicesHost}`;
  }

  private async developmentOrProblem(
    chat: BuilderChat
  ): Promise<{ service: RegisteredService; problem: null } | { service: null; problem: string }> {
    try {
      const service = await this.registry.development(chat.serviceId);
      return service ? { service, problem: null } : { service: null, problem: 'no Development environment' };
    } catch (error) {
      if (!(error instanceof UnservableCustomService)) throw error;
      return { service: null, problem: error.message };
    }
  }

  private async requireTestProject(chat: BuilderChat): Promise<TestProjectView> {
    const testProject = await this.testProjectOf(chat);
    if (!testProject) this.refuseNoTestProject();
    return testProject;
  }

  private async testProjectOf(chat: BuilderChat): Promise<TestProjectView | null> {
    const [row] = await db
      .select({
        id: projects.id,
        agentId: projects.agentId,
        title: projects.title,
        disabled: projects.disabled,
        projectEnvironmentId: projectEnvironments.id,
        status: projectEnvironments.status,
      })
      .from(projects)
      .innerJoin(
        projectEnvironments,
        and(eq(projectEnvironments.projectId, projects.id), eq(projectEnvironments.isDefault, true))
      )
      .where(
        and(
          eq(projects.tenantId, chat.tenantId),
          eq(projects.kind, TEST_PROJECT_KIND),
          eq(projects.createdByProjectId, chat.chatId)
        )
      )
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(1);
    return row ?? null;
  }

  private refuseSecondTestProject(existing: TestProjectView): never {
    refuse({
      status: 409,
      code: 'test-project-exists',
      detail: 'This builder chat already has its Test Project; Update or Reset it instead.',
      testProjectId: existing.id,
    });
  }

  private refuseNoTestProject(): never {
    refuse({
      status: 404,
      code: 'no-test-project',
      detail: 'This builder chat has no Test Project yet; create it first.',
    });
  }
}

function eventLimitOf(limit: string | undefined): number {
  if (limit === undefined) return BUILDER_LANE_EVENTS_LIMIT;
  const value = Number(limit);
  if (!/^\d+$/.test(limit) || value < 1 || value > BUILDER_LANE_MAX_EVENTS) {
    refuse({
      status: 400,
      code: 'invalid-limit',
      detail: `limit must be a whole number from 1 to ${BUILDER_LANE_MAX_EVENTS}.`,
    });
  }
  return value;
}
