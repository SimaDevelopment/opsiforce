import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, projectEnvironments, projects, type ProjectKindValue } from '../../../db/schema';
import { GatewayKeyService } from '../../gateway/gateway-key.service';

export interface GateCaller {
  tenantId: string;
  projectId: string;
  projectTitle: string | null;
  projectKind: ProjectKindValue | null;
  projectEnvironmentId: string;
  environment: string;
  environmentName: string;
}

export type GateCallerSource = { serviceKey: string | null } | { caller: GateCaller };

@Injectable()
export class GateCallers {
  constructor(private readonly keys: GatewayKeyService) {}

  resolve(source: GateCallerSource): Promise<GateCaller | null> {
    return 'caller' in source ? Promise.resolve(source.caller) : this.byServiceKey(source.serviceKey);
  }

  async byServiceKey(token: string | null): Promise<GateCaller | null> {
    if (token === null) return null;
    const identity = await this.keys.validateToken(token);
    if (!identity?.projectEnvironmentId || !identity.tenantId) return null;
    return this.byProjectEnvironment(identity.tenantId, identity.projectEnvironmentId);
  }

  async byProjectEnvironment(tenantId: string, projectEnvironmentId: string): Promise<GateCaller | null> {
    const caller = await this.ofProjectEnvironment(projectEnvironmentId);
    return caller?.tenantId === tenantId ? caller : null;
  }

  async ofProjectEnvironment(projectEnvironmentId: string): Promise<GateCaller | null> {
    const [row] = await db
      .select({
        tenantId: projects.tenantId,
        projectId: projects.id,
        projectTitle: projects.title,
        projectKind: projects.kind,
        environment: environments.slug,
        environmentName: environments.name,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (!row?.tenantId) return null;
    return {
      tenantId: row.tenantId,
      projectId: row.projectId,
      projectTitle: row.projectTitle,
      projectKind: row.projectKind,
      projectEnvironmentId,
      environment: row.environment ?? 'default',
      environmentName: row.environmentName ?? 'Default',
    };
  }
}
