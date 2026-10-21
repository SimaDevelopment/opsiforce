import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../tenant/tenant.decorator';
import { GatewayAuthGuard } from '../gateway/gateway-auth.guard';
import type { GatewayRequest } from '../gateway/gateway-key.service';
import { parseAgentObservation } from './agent-observation';
import { AgentObservationsService } from './agent-observations.service';

@Public()
@UseGuards(GatewayAuthGuard)
@Controller('gateway/agent')
export class AgentObservationsController {
  constructor(private readonly observations: AgentObservationsService) {}

  @Post('observations')
  @HttpCode(HttpStatus.NO_CONTENT)
  async observe(@Body() body: unknown, @Req() req: GatewayRequest): Promise<void> {
    const observation = parseAgentObservation(body);
    if (!observation) throw new BadRequestException('An observation needs a string "kind" and "sessionId"');
    const { projectId, projectEnvironmentId } = req.gatewayContext;
    await this.observations.observe({ projectId, environmentId: projectEnvironmentId ?? projectId }, observation);
  }
}
