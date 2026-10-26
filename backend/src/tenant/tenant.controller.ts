import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, PlatformScope, type TenantContext } from './tenant.decorator';
import { TenantService } from './tenant.service';
import type { TenantConfigResponse, UpdateTenantConfigDto } from './tenant.types';

@Controller('tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get()
  @PlatformScope()
  async findAll(@Req() req: FastifyRequest) {
    const groupsHeader = (req.headers['x-forwarded-groups'] as string) ?? '';
    const tenantNames = this.tenantService.resolveAccessibleTenantNames(groupsHeader);
    return this.tenantService.getOrCreateTenants(tenantNames);
  }

  @Get('config')
  getConfig(@CurrentTenant() tenant: TenantContext): Promise<TenantConfigResponse> {
    return this.tenantService.getTenantConfig(tenant.tenantId);
  }

  @Patch('config')
  @RequirePermission('can_manage_workspaces')
  updateConfig(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: UpdateTenantConfigDto | undefined
  ): Promise<TenantConfigResponse> {
    return this.tenantService.updateTenantConfig(tenant, body);
  }
}
