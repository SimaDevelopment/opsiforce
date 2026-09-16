import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../tenant/tenant.decorator';
import { GatewayAuthGuard } from '../gateway/gateway-auth.guard';
import type { GatewayRequest } from '../gateway/gateway-key.service';
import { AgentStatusService } from './agent-status.service';

interface AgentStatusDto {
  working?: boolean;
}

@Public()
@UseGuards(GatewayAuthGuard)
@Controller('gateway/agent')
export class AgentStatusController {
  constructor(private readonly agentStatus: AgentStatusService) {}

  @Post('status')
  status(@Body() dto: AgentStatusDto, @Req() req: GatewayRequest): { ok: true } {
    const { projectId, projectEnvironmentId } = req.gatewayContext;
    const environmentId = projectEnvironmentId ?? projectId;
    this.agentStatus.setWorking(projectId, environmentId, dto.working === true);
    return { ok: true };
  }
}
