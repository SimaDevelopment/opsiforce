import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db';
import { getDefaultTenantName, mapGroupsToTenants } from '../permission/sso-group-map';
import { tenantSettings, tenants } from '../../db/schema';
import { BifrostService } from '../bifrost/bifrost.service';
import { DefaultsService } from '../defaults/defaults.service';
import { EnvironmentService } from '../environment/environment.service';
import type { TenantContext } from './tenant.decorator';
import type { TenantConfigResponse, UpdateTenantConfigDto } from './tenant.types';

export const OPSIFORCE_TENANT_GROUP_PREFIX = 'role:opsiforce_tenant_name_';

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);
  private readonly pendingTenants = new Map<string, Promise<typeof tenants.$inferSelect>>();
  constructor(
    private readonly bifrostService: BifrostService,
    private readonly defaultsService: DefaultsService,
    private readonly environmentService: EnvironmentService
  ) {}

  parseGroupsByPrefix(groupsHeader: string, prefix: string): string[] {
    return groupsHeader
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g.startsWith(prefix))
      .map((g) => g.slice(prefix.length));
  }

  resolveAccessibleTenantNames(groupsHeader: string | undefined): string[] {
    const header = groupsHeader ?? '';
    const defaultTenantName = getDefaultTenantName();
    const groupTenants = mapGroupsToTenants(header) ?? this.parseGroupsByPrefix(header, OPSIFORCE_TENANT_GROUP_PREFIX);
    return defaultTenantName ? [...new Set([defaultTenantName, ...groupTenants])] : groupTenants;
  }

  private async ensureBifrostCustomer(tenant: typeof tenants.$inferSelect) {
    if (!this.bifrostService.isEnabled()) return tenant;

    try {
      const customerId = await this.bifrostService.createTenantCustomer(tenant.id, tenant.name);
      return { ...tenant, bifrostTenantId: customerId };
    } catch (err) {
      this.logger.warn(`Failed to create Bifrost customer for tenant ${tenant.name}: ${(err as Error).message}`);
      return tenant;
    }
  }

  async getOrCreateTenant(name: string) {
    const pending = this.pendingTenants.get(name);
    if (pending) return pending;

    const promise = this.doGetOrCreateTenant(name).finally(() => this.pendingTenants.delete(name));
    this.pendingTenants.set(name, promise);
    return promise;
  }

  private async doGetOrCreateTenant(name: string) {
    const [existing] = await db.select().from(tenants).where(eq(tenants.name, name));

    if (existing) {
      if (existing.bifrostTenantId) return existing;
      return this.ensureBifrostCustomer(existing);
    }

    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(tenants)
        .values({ id: crypto.randomUUID(), name, displayName: name })
        .onConflictDoNothing()
        .returning();
      if (!inserted) return undefined;
      await tx.insert(tenantSettings).values({ tenantId: inserted.id, externalTenantName: name }).onConflictDoNothing();
      return inserted;
    });

    const tenant = created ?? (await db.select().from(tenants).where(eq(tenants.name, name)))[0];
    if (created) {
      await this.defaultsService.seedTenantDefaults(tenant.id).catch((err) => {
        this.logger.warn(`Failed to seed defaults for tenant ${tenant.name}: ${(err as Error).message}`);
      });
      await this.environmentService.ensureDefaultForTenant(tenant.id).catch((err) => {
        this.logger.warn(`Failed to seed environments for tenant ${tenant.name}: ${(err as Error).message}`);
      });
    }
    return this.ensureBifrostCustomer(tenant);
  }

  async getOrCreateTenants(names: string[]) {
    return Promise.all(names.map((name) => this.getOrCreateTenant(name)));
  }

  async getTenantById(id: string) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));
    return tenant ?? null;
  }

  async getTenantConfig(tenantId: string): Promise<TenantConfigResponse> {
    return { privateWorkspaceEnabled: await this.isPrivateWorkspaceEnabled(tenantId) };
  }

  async isPrivateWorkspaceEnabled(tenantId: string): Promise<boolean> {
    const [row] = await db
      .select({ privateWorkspaceEnabled: tenantSettings.privateWorkspaceEnabled })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    return row?.privateWorkspaceEnabled ?? true;
  }

  async updateTenantConfig(
    tenant: TenantContext,
    dto: UpdateTenantConfigDto | undefined
  ): Promise<TenantConfigResponse> {
    if (typeof dto?.privateWorkspaceEnabled !== 'boolean') {
      throw new BadRequestException('privateWorkspaceEnabled must be a boolean');
    }
    await db
      .insert(tenantSettings)
      .values({
        tenantId: tenant.tenantId,
        externalTenantName: tenant.tenantName,
        privateWorkspaceEnabled: dto.privateWorkspaceEnabled,
      })
      .onConflictDoUpdate({
        target: tenantSettings.tenantId,
        set: { privateWorkspaceEnabled: dto.privateWorkspaceEnabled },
      });
    return this.getTenantConfig(tenant.tenantId);
  }

  async getTenantByExternalName(externalTenantName: string) {
    const [row] = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        displayName: tenants.displayName,
        bifrostTenantId: tenants.bifrostTenantId,
        createdAt: tenants.createdAt,
      })
      .from(tenantSettings)
      .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
      .where(eq(tenantSettings.externalTenantName, externalTenantName));
    return row ?? null;
  }
}
