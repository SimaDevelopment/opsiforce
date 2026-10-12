import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db';
import { projectGatewayKeys } from '../../db/schema';

export interface GatewayIdentity {
  projectId: string;
  projectEnvironmentId: string | null;
  tenantId: string | null;
}

export type GatewayRequest = FastifyRequest & { gatewayContext: GatewayIdentity };

@Injectable()
export class GatewayKeyService {
  private readonly logger = new Logger(GatewayKeyService.name);

  async createKey(projectId: string, projectEnvironmentId: string, tenantId: string | null): Promise<string> {
    const [existing] = await db
      .select()
      .from(projectGatewayKeys)
      .where(
        and(eq(projectGatewayKeys.projectEnvironmentId, projectEnvironmentId), eq(projectGatewayKeys.status, 'active'))
      );

    if (existing) return existing.token;

    const token = `gw-${crypto.randomUUID()}`;

    await db.insert(projectGatewayKeys).values({
      id: crypto.randomUUID(),
      projectId,
      projectEnvironmentId,
      tenantId,
      token,
      status: 'active',
    });

    this.logger.log(`Created gateway key for environment ${projectEnvironmentId}`);
    return token;
  }

  async validateToken(token: string): Promise<GatewayIdentity | null> {
    const [key] = await db
      .select({
        projectId: projectGatewayKeys.projectId,
        projectEnvironmentId: projectGatewayKeys.projectEnvironmentId,
        tenantId: projectGatewayKeys.tenantId,
      })
      .from(projectGatewayKeys)
      .where(and(eq(projectGatewayKeys.token, token), eq(projectGatewayKeys.status, 'active')));

    return key ?? null;
  }

  async getEnvironmentToken(projectEnvironmentId: string): Promise<string | null> {
    const [key] = await db
      .select({ token: projectGatewayKeys.token })
      .from(projectGatewayKeys)
      .where(
        and(eq(projectGatewayKeys.projectEnvironmentId, projectEnvironmentId), eq(projectGatewayKeys.status, 'active'))
      );

    return key?.token ?? null;
  }

  async revokeKeys(projectId: string): Promise<void> {
    await db
      .update(projectGatewayKeys)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(and(eq(projectGatewayKeys.projectId, projectId), eq(projectGatewayKeys.status, 'active')));

    this.logger.log(`Revoked gateway keys for project ${projectId}`);
  }

  async revokeEnvironmentKeys(projectEnvironmentId: string): Promise<void> {
    await db
      .update(projectGatewayKeys)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(
        and(eq(projectGatewayKeys.projectEnvironmentId, projectEnvironmentId), eq(projectGatewayKeys.status, 'active'))
      );

    this.logger.log(`Revoked gateway keys for environment ${projectEnvironmentId}`);
  }
}
