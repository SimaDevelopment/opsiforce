import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseFilters } from '@nestjs/common';
import { RequirePermission } from '../../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../../user/user.decorator';
import { UserService } from '../../user/user.service';
import type { ServiceConsumer } from '../configuration/service-consumers';
import { CustomServiceRefusalFilter } from './custom-service-refusal';
import type { CustomServiceSummary } from './custom-service-summary';
import { CustomServices, type NewCustomServiceRequest } from './custom-services.service';

@Controller('external-services/services')
@RequirePermission('can_manage_tenant_external_services')
@UseFilters(CustomServiceRefusalFilter)
export class CustomServicesController {
  constructor(
    private readonly services: CustomServices,
    private readonly users: UserService
  ) {}

  @Post()
  async create(
    @Body() body: NewCustomServiceRequest | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomServiceSummary> {
    const userId = await this.users.resolveUserId(user, tenant.tenantId);
    return this.services.create({ tenantId: tenant.tenantId, userId }, body ?? {});
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id') id: string, @CurrentTenant() tenant: TenantContext): Promise<CustomServiceSummary> {
    return this.services.disable(tenant.tenantId, id);
  }

  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string, @CurrentTenant() tenant: TenantContext): Promise<CustomServiceSummary> {
    return this.services.enable(tenant.tenantId, id);
  }

  @Get(':id/consumers')
  consumers(@Param('id') id: string, @CurrentTenant() tenant: TenantContext): Promise<ServiceConsumer[]> {
    return this.services.consumersOf(tenant.tenantId, id);
  }

  @Delete(':id/consumers/:projectEnvironmentId')
  @HttpCode(204)
  async disconnect(
    @Param('id') id: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @CurrentTenant() tenant: TenantContext
  ): Promise<void> {
    await this.services.disconnect(tenant.tenantId, id, projectEnvironmentId);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(
    @Param('id') id: string,
    @Query('confirmSlug') confirmSlug: unknown,
    @CurrentTenant() tenant: TenantContext
  ): Promise<void> {
    return this.services.delete(tenant.tenantId, id, confirmSlug);
  }

  @Patch(':id')
  renameSlug(
    @Param('id') id: string,
    @Body() body: { slug?: unknown } | undefined,
    @CurrentTenant() tenant: TenantContext
  ): Promise<CustomServiceSummary> {
    return this.services.renameSlug(tenant.tenantId, id, body?.slug);
  }
}
