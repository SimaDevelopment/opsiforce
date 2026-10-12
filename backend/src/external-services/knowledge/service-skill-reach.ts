import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices, skills } from '../../../db/schema';
import { errorMessage } from '../../common/error-message';
import { serviceSkillName } from '../../delivery/service-skill-source';
import { SkillDeliveryService } from '../../delivery/skill-delivery.service';
import { CustomServiceCatalog, servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { ServiceAvailability } from '../configuration/service-availability';
import {
  deliveredServiceSkills,
  environmentsBehindTheirServiceSkills,
  environmentsReachedBy,
  stillExisting,
} from './service-skill.repository';
import { ServiceSkillVersions } from './service-skill-versions';

@Injectable()
export class ServiceSkillReach implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ServiceSkillReach.name);

  constructor(
    private readonly skillDeliveries: SkillDeliveryService,
    private readonly versions: ServiceSkillVersions,
    private readonly registry: ServiceRegistry,
    private readonly availability: ServiceAvailability,
    private readonly customs: CustomServiceCatalog
  ) {}

  onModuleInit(): void {
    this.customs.whenDefaultFilesChange((service) => this.refreshFrom(service));
  }

  private async refreshFrom(service: RegisteredService): Promise<void> {
    if (await this.versions.lay(service)) await this.reachEnvironmentsOf(service);
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const service of [...this.registry.list(), ...(await this.publishedWithoutServiceSkill())]) {
      const laid = await this.versions.lay(service).catch((error) => {
        this.logger.warn(
          `The ${serviceSkillName(service.slug)} Service skill could not be laid: ${errorMessage(error)}`
        );
        return false;
      });
      if (laid) await this.reachEnvironmentsOf(service);
    }
    const behind = await this.staleEnvironments();
    if (behind.length === 0) return;
    await this.skillDeliveries.enqueueEnvironments(behind);
    this.logger.log(`Redelivering Service skills to ${behind.length} environment(s) whose services changed`);
  }

  async layAndReach(service: RegisteredService): Promise<void> {
    await this.versions.lay(service);
    await this.reachEnvironmentsOf(service);
  }

  async reachEnvironmentsOf(service: Pick<RegisteredService, 'id' | 'slug'>): Promise<void> {
    await this.reachEnvironmentsAfter(service, () => Promise.resolve());
  }

  /** Targets are read before the change, which may delete the service and with it its Service skill. */
  async reachEnvironmentsAfter(
    service: Pick<RegisteredService, 'id' | 'slug'>,
    change: () => Promise<unknown>
  ): Promise<void> {
    const reached = await environmentsReachedBy(service.id, serviceSkillName(service.slug));
    await change();
    await this.skillDeliveries.enqueueEnvironments(await stillExisting(reached));
    this.logger.log(
      `${service.slug} changed availability; redelivering its Service skill to ${reached.length} environment(s)`
    );
  }

  async staleEnvironments(): Promise<string[]> {
    const stale = new Set(await environmentsBehindTheirServiceSkills());
    const availableByTenant = new Map<string | null, Set<string>>();
    for (const skill of await deliveredServiceSkills()) {
      if (skill.testedSlug && serviceSkillName(skill.testedSlug) === skill.skillName) continue;
      let available = availableByTenant.get(skill.tenantId);
      if (!available) {
        available = new Set(
          (await this.availability.availableToTenant(skill.tenantId)).map((service) => serviceSkillName(service.slug))
        );
        availableByTenant.set(skill.tenantId, available);
      }
      if (!available.has(skill.skillName)) stale.add(skill.projectEnvironmentId);
    }
    return [...stale];
  }

  private async publishedWithoutServiceSkill(): Promise<RegisteredService[]> {
    const rows = await db
      .select({ id: externalServices.id })
      .from(externalServices)
      .leftJoin(skills, eq(skills.externalServiceId, externalServices.id))
      .where(and(isNotNull(externalServices.defaultEnvironmentId), isNull(skills.latestVersionId)));
    const published = await Promise.all(rows.map((row) => servableOrNone(this.registry.publishedCustom(row.id))));
    return published.filter((service): service is RegisteredService => !!service);
  }
}
