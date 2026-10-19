import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments, projects } from '../../../db/schema';
import { errorMessage } from '../../common/error-message';
import { SecretUnreadableError } from '../../sealing/secret-sealer';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { ConfigurationSaves } from './configuration-saves';
import { ProjectConfigurationStore } from './project-configuration.store';

export type ProjectConfigurationCarryLine =
  | {
      kind: 'project-configuration';
      service: string;
      displayName: string;
      outcome: 'carried';
    }
  | { kind: 'project-configuration'; service: string; displayName: string; outcome: 'failed'; code: string };

@Injectable()
export class ProjectConfigurationCarry {
  private readonly logger = new Logger(ProjectConfigurationCarry.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly store: ProjectConfigurationStore,
    private readonly saves: ConfigurationSaves
  ) {}

  async carry(sourceEnvironmentId: string, targetEnvironmentId: string): Promise<ProjectConfigurationCarryLine[]> {
    if (sourceEnvironmentId === targetEnvironmentId) return [];
    const configured = new Set(await this.store.configuredServiceIds(sourceEnvironmentId));
    const lines: ProjectConfigurationCarryLine[] = [];
    for (const service of await this.servicesOf(sourceEnvironmentId)) {
      if (!configured.has(service.id)) continue;
      const line = await this.carryService(service, sourceEnvironmentId, targetEnvironmentId);
      if (line) lines.push(line);
    }
    return lines;
  }

  private async servicesOf(projectEnvironmentId: string): Promise<readonly RegisteredService[]> {
    const [row] = await db
      .select({ tenantId: projects.tenantId })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    return row?.tenantId ? this.registry.listForTenant(row.tenantId) : this.registry.list();
  }

  private async carryService(
    service: RegisteredService,
    sourceEnvironmentId: string,
    targetEnvironmentId: string
  ): Promise<ProjectConfigurationCarryLine | null> {
    const named = {
      kind: 'project-configuration',
      service: service.slug,
      displayName: service.manifest.displayName,
    } as const;
    try {
      const carried = await this.saves.carried(service, sourceEnvironmentId, targetEnvironmentId, () =>
        this.store.carry(service, sourceEnvironmentId, targetEnvironmentId)
      );
      if (!carried) return null;
      return { ...named, outcome: 'carried' };
    } catch (err) {
      this.logger.warn(
        `Carrying the ${service.slug} Project configuration from ${sourceEnvironmentId} to ${targetEnvironmentId} failed: ${errorMessage(err)}`
      );
      return { ...named, outcome: 'failed', code: err instanceof SecretUnreadableError ? err.code : 'carry-failed' };
    }
  }
}
