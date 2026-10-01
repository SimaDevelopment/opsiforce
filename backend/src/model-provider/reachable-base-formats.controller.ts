import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { AgentCallerRefusalGuard } from './agent-caller-refusal.guard';
import type { BaseFormatId } from './base-formats';
import { ModelProvidersService } from './model-provider.service';

@Controller('model-providers/reachable-formats')
@UseGuards(AgentCallerRefusalGuard)
export class ReachableBaseFormatsController {
  constructor(private readonly modelProvidersService: ModelProvidersService) {}

  @Get()
  list(@CurrentTenant() tenant: TenantContext): Promise<BaseFormatId[]> {
    return this.modelProvidersService.reachableBaseFormats(tenant.tenantId);
  }
}
