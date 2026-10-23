import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import type { DbExecutor } from '../common/locks';
import { GatewayKeyService } from '../gateway/gateway-key.service';
import type { ProjectLifecycle } from '../project/project-lifecycle';
import { ServiceConsumers } from './configuration/service-consumers';
import { CustomServiceRepository } from './custom/custom-service.repository';
import { GateEviction } from './gate/gate-eviction';
import { ServiceSkillReach } from './knowledge/service-skill-reach';
import { unpinServiceSkillsOfBuilderChat } from './knowledge/service-skill.repository';
import { servesAsServiceDefault } from './publishing/service-default-environments';
import { ConfigurationsAtCreate } from './test-lane/configurations-at-create';
import { TestProjectRefreshes } from './test-lane/test-project-refreshes';

@Injectable()
export class ExternalServicesProjectLifecycle implements ProjectLifecycle {
  constructor(
    private readonly configurationsAtCreate: ConfigurationsAtCreate,
    private readonly testProjectRefreshes: TestProjectRefreshes,
    private readonly consumers: ServiceConsumers,
    private readonly serviceSkillReach: ServiceSkillReach,
    private readonly customServices: CustomServiceRepository,
    private readonly gatewayKeys: GatewayKeyService,
    private readonly gate: GateEviction
  ) {}

  async created(projectEnvironmentId: string): Promise<void> {
    await this.configurationsAtCreate.startConfigurations(projectEnvironmentId);
    await this.configurationsAtCreate.configureServiceUnderTest(projectEnvironmentId);
  }

  delivered(projectEnvironmentId: string): Promise<void> {
    return this.configurationsAtCreate.announceStartedConfigurations(projectEnvironmentId);
  }

  copied(projectEnvironmentId: string): Promise<void> {
    return this.configurationsAtCreate.startCopiedConfigurations(projectEnvironmentId);
  }

  updated(projectEnvironmentId: string): Promise<void> {
    return this.testProjectRefreshes.updated(projectEnvironmentId);
  }

  resetting(projectEnvironmentId: string): Promise<void> {
    return this.testProjectRefreshes.resetting(projectEnvironmentId);
  }

  async disabled(projectId: string): Promise<void> {
    const tokens = await this.gatewayKeys.activeProjectTokens(projectId);
    const service = await this.customServices.findByBuilderChat(projectId);
    await Promise.all([
      ...tokens.map((token) => this.gate.evictGatewayKey(token)),
      ...(service ? [this.gate.evictService(service.tenantId, service.slug)] : []),
    ]);
    if (service) await this.serviceSkillReach.reachEnvironmentsOf(service);
  }

  enabled(projectId: string): Promise<void> {
    return this.reachServiceSkillOfBuilderChat(projectId);
  }

  environmentRemoving(projectEnvironmentId: string): Promise<void> {
    return this.consumers.sayGoodbyeIn(projectEnvironmentId);
  }

  async gatewayKeysRevoked(projectId: string, tokens: string[]): Promise<void> {
    const service = await this.customServices.findByBuilderChat(projectId);
    await Promise.all([
      ...tokens.map((token) => this.gate.evictGatewayKey(token)),
      ...(service ? [this.gate.evictService(service.tenantId, service.slug)] : []),
    ]);
  }

  removing(tx: DbExecutor, projectId: string): Promise<void> {
    return unpinServiceSkillsOfBuilderChat(tx, projectId);
  }

  async neverSleeps(projectEnvironmentId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(and(eq(projectEnvironments.id, projectEnvironmentId), servesAsServiceDefault()));
    return !!row;
  }

  private async reachServiceSkillOfBuilderChat(projectId: string): Promise<void> {
    const service = await this.customServices.findByBuilderChat(projectId);
    if (service) await this.serviceSkillReach.reachEnvironmentsOf(service);
  }
}
