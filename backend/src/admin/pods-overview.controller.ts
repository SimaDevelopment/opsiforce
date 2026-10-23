import { Controller, Get } from '@nestjs/common';
import { PodsOverviewService } from './pods-overview.service';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import type { PodsView } from './pods-overview.types';

@Controller('pods')
export class PodsOverviewController {
  constructor(private readonly podsOverviewService: PodsOverviewService) {}

  @Get()
  @RequirePermission('can_view_pods')
  list(@CurrentTenant() tenant: TenantContext): Promise<PodsView> {
    return this.podsOverviewService.listForTenant(tenant.tenantId);
  }
}
