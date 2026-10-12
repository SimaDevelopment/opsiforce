import { Controller, Get, Query } from '@nestjs/common';
import { Perms } from '../../permission/permission.constants';
import { RequirePermission } from '../../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../../tenant/tenant.decorator';
import { CallLogReader, parseCallPageQuery, type CallPage } from '../calls/call-log-reader';
import { ExternalServiceUsageService } from './external-service-usage.service';
import type { UsageView } from './external-service-usage.types';

@Controller('external-services/admin')
export class ExternalServiceUsageController {
  constructor(
    private readonly usageService: ExternalServiceUsageService,
    private readonly calls: CallLogReader
  ) {}

  @Get('usage')
  @RequirePermission(Perms.viewExternalServicesUsage)
  usage(@CurrentTenant() tenant: TenantContext, @Query('month') month?: string): Promise<UsageView> {
    return this.usageService.view(month, tenant.tenantId);
  }

  @Get('calls')
  @RequirePermission(Perms.viewExternalServicesUsage)
  listCalls(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>): Promise<CallPage> {
    return this.calls.page({ tenantId: tenant.tenantId }, parseCallPageQuery(query));
  }
}
