import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { EnvironmentService } from './environment.service';
import { CreateEnvironmentDto, UpdateEnvironmentDto } from './environment.types';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { RequirePermission } from '../permission/permission.guard';

@Controller('environments')
export class EnvironmentController {
  constructor(private readonly environmentService: EnvironmentService) {}

  @Get()
  list(@CurrentTenant() tenant: TenantContext) {
    return this.environmentService.listForTenant(tenant.tenantId);
  }

  @Post()
  @RequirePermission('can_manage_environments')
  create(@Body() dto: CreateEnvironmentDto, @CurrentTenant() tenant: TenantContext) {
    return this.environmentService.create(tenant.tenantId, dto ?? {});
  }

  @Patch(':id')
  @RequirePermission('can_manage_environments')
  update(@Param('id') id: string, @Body() dto: UpdateEnvironmentDto, @CurrentTenant() tenant: TenantContext) {
    return this.environmentService.update(tenant.tenantId, id, dto ?? {});
  }

  @Delete(':id')
  @RequirePermission('can_manage_environments')
  async remove(@Param('id') id: string, @CurrentTenant() tenant: TenantContext) {
    await this.environmentService.remove(tenant.tenantId, id);
    return { ok: true };
  }
}
