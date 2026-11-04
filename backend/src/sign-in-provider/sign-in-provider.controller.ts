import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AgentCallerRefusalGuard } from '../model-provider/agent-caller-refusal.guard';
import { RequireAnyPermission, RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { SignInProvidersService } from './sign-in-provider.service';
import type { SaveSignInProviderDto, SignInProviderOption, SignInProviderView } from './sign-in-provider.types';

@Controller('sign-in-providers')
@UseGuards(AgentCallerRefusalGuard)
export class SignInProvidersController {
  constructor(private readonly signInProvidersService: SignInProvidersService) {}

  @Get()
  @RequirePermission('can_manage_tenant_sign_in_providers')
  list(@CurrentTenant() tenant: TenantContext): Promise<SignInProviderView[]> {
    return this.signInProvidersService.list(tenant.tenantId);
  }

  @Get('options')
  @RequireAnyPermission(['can_manage_project_auth_settings', 'can_manage_tenant_sign_in_providers'])
  options(@CurrentTenant() tenant: TenantContext): Promise<SignInProviderOption[]> {
    return this.signInProvidersService.options(tenant.tenantId);
  }

  @Post()
  @RequirePermission('can_manage_tenant_sign_in_providers')
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: SaveSignInProviderDto | undefined
  ): Promise<SignInProviderView> {
    return this.signInProvidersService.create(tenant.tenantId, dto ?? {});
  }

  @Patch(':id')
  @RequirePermission('can_manage_tenant_sign_in_providers')
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() dto: SaveSignInProviderDto | undefined
  ): Promise<SignInProviderView> {
    return this.signInProvidersService.update(tenant.tenantId, id, dto ?? {});
  }

  @Delete(':id')
  @RequirePermission('can_manage_tenant_sign_in_providers')
  async remove(@CurrentTenant() tenant: TenantContext, @Param('id') id: string): Promise<{ ok: true }> {
    await this.signInProvidersService.remove(tenant.tenantId, id);
    return { ok: true };
  }
}
