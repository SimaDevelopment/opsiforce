import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { AgentCallerRefusalGuard } from './agent-caller-refusal.guard';
import { ModelProvidersService } from './model-provider.service';
import type { SaveBaseFormatDto, TenantModelProvidersView } from './model-provider.types';

@Controller('model-providers')
@RequirePermission('can_manage_tenant_model_providers')
@UseGuards(AgentCallerRefusalGuard)
export class ModelProvidersController {
  constructor(private readonly modelProvidersService: ModelProvidersService) {}

  @Get()
  list(@CurrentTenant() tenant: TenantContext): Promise<TenantModelProvidersView> {
    return this.modelProvidersService.listTenantProviders(tenant);
  }

  @Put('formats/:format')
  saveBaseFormat(
    @CurrentTenant() tenant: TenantContext,
    @Param('format') format: string,
    @Body() body: SaveBaseFormatDto | undefined
  ): Promise<TenantModelProvidersView> {
    return this.modelProvidersService.saveBaseFormat(
      tenant,
      format,
      body?.providers,
      body?.acknowledgeAffectedAgents === true
    );
  }
}
