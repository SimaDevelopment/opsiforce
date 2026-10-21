import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Perms } from '../permission/permission.constants';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { AgentCallerRefusalGuard } from './agent-caller-refusal.guard';
import { ModelProviderCreationService } from './model-provider-creation.service';
import type {
  ConnectionTestPassed,
  EditModelProviderConnectionDto,
  ModelProviderConnectionDto,
  ModelProviderCreationRules,
  NewModelProviderDto,
  SetModelProviderModelsDto,
  TenantModelProvidersView,
} from './model-provider.types';

@Controller('model-providers')
@RequirePermission(Perms.manageTenantModelProviders)
@UseGuards(AgentCallerRefusalGuard)
export class ModelProviderCreationController {
  constructor(private readonly creationService: ModelProviderCreationService) {}

  @Get('creation-rules')
  rules(@CurrentTenant() tenant: TenantContext): Promise<ModelProviderCreationRules> {
    return this.creationService.rules(tenant);
  }

  @Post('test')
  @HttpCode(200)
  test(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: NewModelProviderDto | undefined
  ): Promise<ConnectionTestPassed> {
    return this.creationService.test(tenant, body);
  }

  @Post()
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: NewModelProviderDto | undefined
  ): Promise<TenantModelProvidersView> {
    return this.creationService.create(tenant, body);
  }

  @Patch(':name')
  editConnection(
    @CurrentTenant() tenant: TenantContext,
    @Param('name') name: string,
    @Body() body: EditModelProviderConnectionDto | undefined
  ): Promise<TenantModelProvidersView> {
    return this.creationService.editConnection(tenant, name, body);
  }

  @Put(':name/models')
  setModels(
    @CurrentTenant() tenant: TenantContext,
    @Param('name') name: string,
    @Body() body: SetModelProviderModelsDto | undefined
  ): Promise<TenantModelProvidersView> {
    return this.creationService.setModels(tenant, name, body);
  }

  @Post(':name/re-enter-key')
  @HttpCode(200)
  reenterKey(
    @CurrentTenant() tenant: TenantContext,
    @Param('name') name: string,
    @Body() body: ModelProviderConnectionDto | undefined
  ): Promise<TenantModelProvidersView> {
    return this.creationService.reenterKey(tenant, name, body);
  }

  @Delete(':name')
  delete(@CurrentTenant() tenant: TenantContext, @Param('name') name: string): Promise<TenantModelProvidersView> {
    return this.creationService.delete(tenant, name);
  }
}
