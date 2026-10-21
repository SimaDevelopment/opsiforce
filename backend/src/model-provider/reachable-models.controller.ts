import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { AgentCallerRefusalGuard } from './agent-caller-refusal.guard';
import { ModelProvidersService } from './model-provider.service';

@Controller('model-providers/reachable-models')
@UseGuards(AgentCallerRefusalGuard)
export class ReachableModelsController {
  constructor(private readonly modelProvidersService: ModelProvidersService) {}

  @Get()
  list(@CurrentTenant() tenant: TenantContext): Promise<string[]> {
    return this.modelProvidersService.reachableModels(tenant.tenantId);
  }
}
