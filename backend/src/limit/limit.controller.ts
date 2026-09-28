import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { Perms } from '../permission/permission.constants';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, PlatformScope, type TenantContext } from '../tenant/tenant.decorator';
import { LimitService } from './limit.service';
import type { LimitUsage, PlatformLimitsView, SetLimitDto } from './limit.types';

@Controller('limits')
export class LimitController {
  constructor(private readonly limitService: LimitService) {}

  @Get()
  usage(@CurrentTenant() tenant: TenantContext): Promise<LimitUsage[]> {
    return this.limitService.usage(tenant.tenantId);
  }

  @Get('platform')
  @PlatformScope()
  @RequirePermission(Perms.managePlatformLimits)
  platformView(): Promise<PlatformLimitsView> {
    return this.limitService.platformView();
  }

  @Put('platform/:key')
  @PlatformScope()
  @RequirePermission(Perms.managePlatformLimits)
  setPlatformLimit(@Param('key') key: string, @Body() body: SetLimitDto | undefined): Promise<PlatformLimitsView> {
    return this.limitService.setPlatformLimit(key, body?.value);
  }

  @Put('tenants/:tenantId/:key')
  @PlatformScope()
  @RequirePermission(Perms.managePlatformLimits)
  setTenantLimit(
    @Param('tenantId') tenantId: string,
    @Param('key') key: string,
    @Body() body: SetLimitDto | undefined
  ): Promise<PlatformLimitsView> {
    return this.limitService.setTenantLimit(tenantId, key, body?.value);
  }

  @Delete('tenants/:tenantId/:key')
  @PlatformScope()
  @RequirePermission(Perms.managePlatformLimits)
  followPlatformLimit(@Param('tenantId') tenantId: string, @Param('key') key: string): Promise<PlatformLimitsView> {
    return this.limitService.followPlatformLimit(tenantId, key);
  }
}
