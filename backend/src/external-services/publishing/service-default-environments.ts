import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices, projectEnvironments } from '../../../db/schema';
import { errorMessage } from '../../common/error-message';
import { callersOwner } from '../configuration/configuration-values';
import { GeneratedValueBackfill } from '../configuration/generated-value-backfill';
import { PublishedDefaults } from '../configuration/published-defaults';
import { ServiceConfigurationSaveHooks } from '../configuration/service-configuration-save-hooks';
import { ServiceSkillReach } from '../knowledge/service-skill-reach';
import { CustomServiceRefusal } from '../custom/custom-service-refusal';
import { ServiceStateFiles } from '../custom/service-state-files';
import { GateEviction } from '../gate/gate-eviction';
import { DefaultLaneHolds, SERVICE_SWITCH_DRAIN_MS } from '../gate/default-lane-holds';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';

export function servesAsServiceDefault(): SQL {
  return sql`exists (select 1 from ${externalServices} where ${externalServices.builderChatId} = ${projectEnvironments.projectId} and ${externalServices.defaultEnvironmentId} = ${projectEnvironments.environmentId})`;
}

@Injectable()
export class ServiceDefaultEnvironments {
  private readonly logger = new Logger(ServiceDefaultEnvironments.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly serviceSkillReach: ServiceSkillReach,
    private readonly backfill: GeneratedValueBackfill,
    private readonly publishedDefaults: PublishedDefaults,
    private readonly serviceSaveHooks: ServiceConfigurationSaveHooks,
    private readonly stateFiles: ServiceStateFiles,
    private readonly holds: DefaultLaneHolds,
    private readonly gate: GateEviction,
    @Inject(SERVICE_SWITCH_DRAIN_MS) private readonly drainMs: number
  ) {}

  async publishedTo(projectId: string, projectEnvironmentId: string): Promise<void> {
    const [target] = await db
      .select({ environmentId: projectEnvironments.environmentId, isDefault: projectEnvironments.isDefault })
      .from(projectEnvironments)
      .where(and(eq(projectEnvironments.id, projectEnvironmentId), eq(projectEnvironments.projectId, projectId)));
    if (!target?.environmentId || target.isDefault) return;
    const updated = await db
      .update(externalServices)
      .set({ defaultEnvironmentId: target.environmentId, updatedAt: new Date() })
      .where(and(eq(externalServices.builderChatId, projectId), isNull(externalServices.defaultEnvironmentId)))
      .returning({ id: externalServices.id, slug: externalServices.slug });
    for (const service of updated) {
      this.logger.log(`Custom External Service ${service.slug} is published; its Default environment is set`);
    }
    const [row] = await db
      .select({ id: externalServices.id })
      .from(externalServices)
      .where(
        and(
          eq(externalServices.builderChatId, projectId),
          eq(externalServices.defaultEnvironmentId, target.environmentId)
        )
      );
    if (row) await this.servedFrom(row.id);
  }

  async switchTo(serviceId: string, environmentId: string): Promise<void> {
    let held = false;
    let switched = false;
    try {
      const moved = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`service-default-switch:${serviceId}`}))`);
        held = true;
        if (!(await this.holds.hold(serviceId, this.drainMs))) {
          throw new CustomServiceRefusal(
            409,
            'service-busy',
            'Calls to the service are still running on its Default environment; try the switch again.'
          );
        }
        await this.stateFiles.copyDefaultTo(serviceId, environmentId);
        return tx
          .update(externalServices)
          .set({ defaultEnvironmentId: environmentId, updatedAt: new Date() })
          .where(eq(externalServices.id, serviceId))
          .returning({ tenantId: externalServices.tenantId, slug: externalServices.slug });
      });
      switched = true;
      for (const row of moved) {
        if (row.tenantId) await this.gate.evictService(row.tenantId, row.slug);
      }
    } finally {
      if (held) this.holds.release(serviceId, switched ? environmentId : undefined);
    }
    await this.servedFrom(serviceId);
  }

  private async servedFrom(serviceId: string): Promise<void> {
    const service = await servableOrNone(this.registry.publishedCustom(serviceId));
    if (service) await this.becameDefault(service);
  }

  private async becameDefault(service: RegisteredService): Promise<void> {
    await this.publishedDefaults.writeInto(service);
    await this.backfill.fillServiceConfigurations(service);
    await this.backfill.fillProjectConfigurations(service);
    const failure = await this.serviceSaveHooks.runPending(service, callersOwner(service)).catch((error) => {
      this.logger.warn(`The ${service.slug} Service configuration hook could not run: ${errorMessage(error)}`);
      return null;
    });
    if (failure) {
      this.logger.warn(`The ${service.slug} Service configuration hook failed after it went live: ${failure.code}`);
    }
    await this.serviceSkillReach.layAndReach(service);
  }
}
