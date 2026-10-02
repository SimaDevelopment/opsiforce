import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { AgentCallerRefusalGuard } from '../model-provider/agent-caller-refusal.guard';
import { Perms } from '../permission/permission.constants';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import type {
  LinkedAccountUsageView,
  LinkedAccountView,
  PastedAccessToken,
  StartedSignInView,
} from './linked-account.types';
import { LinkedAccountsService } from './linked-accounts.service';

@Controller('model-providers')
@RequirePermission(Perms.manageTenantModelProviders)
@UseGuards(AgentCallerRefusalGuard)
export class TenantLinkedAccountsController {
  constructor(private readonly linkedAccountsService: LinkedAccountsService) {}

  @Post(':name/sign-in')
  @HttpCode(200)
  startSignIn(@CurrentTenant() tenant: TenantContext, @Param('name') name: string): Promise<StartedSignInView> {
    return this.linkedAccountsService.startTenantSignIn(tenant, name);
  }

  @Get(':name/linked-account')
  status(@CurrentTenant() tenant: TenantContext, @Param('name') name: string): Promise<LinkedAccountView> {
    return this.linkedAccountsService.tenantStatus(tenant, name);
  }

  @Get(':name/linked-account/usage')
  usage(@CurrentTenant() tenant: TenantContext, @Param('name') name: string): Promise<LinkedAccountUsageView> {
    return this.linkedAccountsService.tenantUsage(tenant, name);
  }

  @Post(':name/access-token')
  @HttpCode(200)
  pasteAccessToken(
    @CurrentTenant() tenant: TenantContext,
    @Param('name') name: string,
    @Body() body: PastedAccessToken | undefined
  ): Promise<LinkedAccountView> {
    return this.linkedAccountsService.pasteTenantAccessToken(tenant, name, body?.accessToken);
  }

  @Post(':name/disconnect')
  @HttpCode(200)
  disconnect(@CurrentTenant() tenant: TenantContext, @Param('name') name: string): Promise<LinkedAccountView> {
    return this.linkedAccountsService.disconnectTenant(tenant, name);
  }
}
