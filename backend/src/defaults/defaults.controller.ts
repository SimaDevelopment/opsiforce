import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put } from '@nestjs/common';
import type { InactivityCleanup } from '../project/inactivity-cleanup';
import { DefaultsService } from './defaults.service';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import type {
  TimeoutDefaults,
  BudgetDefaults,
  UpdateTimeoutDefaultsDto,
  UpdateBudgetDefaultsDto,
} from './defaults.types';

@Controller('defaults')
export class DefaultsController {
  constructor(private readonly defaultsService: DefaultsService) {}

  @Get('global/timeouts')
  @RequirePermission('can_manage_platform_defaults')
  getGlobalTimeouts(): Promise<TimeoutDefaults> {
    return this.defaultsService.getGlobalTimeouts();
  }

  @Patch('global/timeouts')
  @RequirePermission('can_manage_platform_defaults')
  updateGlobalTimeouts(@Body() body: UpdateTimeoutDefaultsDto): Promise<TimeoutDefaults> {
    return this.defaultsService.updateGlobalTimeouts(body);
  }

  @Put('global/agents/:agentId/inactivity-cleanup')
  @RequirePermission('can_manage_platform_defaults')
  @HttpCode(204)
  updateBuiltInAgentInactivityCleanup(
    @Param('agentId') agentId: string,
    @Body() body: Partial<InactivityCleanup>
  ): Promise<void> {
    return this.defaultsService.updateBuiltInAgentInactivityCleanup(agentId, body);
  }

  @Delete('global/agents/:agentId/inactivity-cleanup')
  @RequirePermission('can_manage_platform_defaults')
  @HttpCode(204)
  resetBuiltInAgentInactivityCleanup(@Param('agentId') agentId: string): Promise<void> {
    return this.defaultsService.resetBuiltInAgentInactivityCleanup(agentId);
  }

  @Get('global/budgets')
  @RequirePermission('can_manage_platform_defaults')
  getGlobalBudgets(): Promise<BudgetDefaults> {
    return this.defaultsService.getGlobalBudgets();
  }

  @Patch('global/budgets')
  @RequirePermission('can_manage_platform_defaults')
  updateGlobalBudgets(@Body() body: UpdateBudgetDefaultsDto): Promise<BudgetDefaults> {
    return this.defaultsService.updateGlobalBudgets(body);
  }

  @Get('tenant/timeouts')
  @RequirePermission('can_manage_tenant_defaults')
  getTenantTimeouts(@CurrentTenant() tenant: TenantContext): Promise<TimeoutDefaults> {
    return this.defaultsService.getTenantTimeouts(tenant.tenantId);
  }

  @Patch('tenant/timeouts')
  @RequirePermission('can_manage_tenant_defaults')
  updateTenantTimeouts(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: UpdateTimeoutDefaultsDto
  ): Promise<TimeoutDefaults> {
    return this.defaultsService.updateTenantTimeouts(tenant.tenantId, body);
  }

  @Get('tenant/budgets')
  @RequirePermission('can_manage_tenant_defaults')
  getTenantBudgets(@CurrentTenant() tenant: TenantContext): Promise<BudgetDefaults> {
    return this.defaultsService.getTenantBudgets(tenant.tenantId);
  }

  @Patch('tenant/budgets')
  @RequirePermission('can_manage_tenant_defaults')
  updateTenantBudgets(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: UpdateBudgetDefaultsDto
  ): Promise<BudgetDefaults> {
    return this.defaultsService.updateTenantBudgets(tenant.tenantId, body);
  }
}
