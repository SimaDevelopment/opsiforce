import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../tenant/tenant.decorator';
import { GatewayAuthGuard } from '../gateway/gateway-auth.guard';
import type { GatewayRequest } from '../gateway/gateway-key.service';
import { AppService } from './app.service';
import { AppReadinessService } from './app-readiness.service';
import { ProjectEventsService } from './project-events.service';

interface AppStateDto {
  serving?: boolean;
  live?: boolean;
  name?: string | null;
  description?: string | null;
}

@Public()
@UseGuards(GatewayAuthGuard)
@Controller('gateway/app')
export class AppAgentController {
  constructor(
    private readonly appService: AppService,
    private readonly appReadiness: AppReadinessService,
    private readonly projectEventsService: ProjectEventsService
  ) {}

  @Post('state')
  async state(@Body() dto: AppStateDto, @Req() req: GatewayRequest): Promise<{ ok: true }> {
    const { projectId, projectEnvironmentId } = req.gatewayContext;
    const key = projectEnvironmentId ?? projectId;
    const serving = dto.serving === true;
    const live = dto.live === true;

    if (live) {
      const name = typeof dto.name === 'string' ? dto.name : null;
      const description = typeof dto.description === 'string' ? dto.description : null;
      const changed = await this.appService.upsertProjectApp(key, projectId, { name, description });
      this.appReadiness.markServing(key);
      if (changed) {
        await this.projectEventsService.publish(projectId);
      }
    } else if (serving) {
      this.appReadiness.markServing(key);
    } else {
      this.appReadiness.markDown(key);
    }

    return { ok: true };
  }
}
