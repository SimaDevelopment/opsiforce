import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Doorbell } from '../external-services/doorbell/doorbell';
import { Public } from '../tenant/tenant.decorator';
import { GatewayAuthGuard } from '../gateway/gateway-auth.guard';
import type { GatewayRequest } from '../gateway/gateway-key.service';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { PublicUrlService } from '../project-environment/public-url.service';
import { AppService } from './app.service';
import { AppReadinessService } from './app-readiness.service';
import { ProjectEventsService } from './project-events.service';

interface AppStateDto {
  serving?: boolean;
  live?: boolean;
  name?: string | null;
  description?: string | null;
}

interface AppPublicUrlAnswer {
  publicUrl: string | null;
  servesAnExternalService: boolean;
}

@Public()
@UseGuards(GatewayAuthGuard)
@Controller('gateway/app')
export class AppAgentController {
  constructor(
    private readonly appService: AppService,
    private readonly appReadiness: AppReadinessService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly doorbell: Doorbell,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly publicUrls: PublicUrlService
  ) {}

  @Get('public-url')
  async publicUrl(@Req() req: GatewayRequest): Promise<AppPublicUrlAnswer> {
    const { projectId, projectEnvironmentId } = req.gatewayContext;
    const env = await this.projectEnvironmentService.findById(projectEnvironmentId ?? projectId);
    return { publicUrl: this.publicUrls.publicUrlOnceLive(env), servesAnExternalService: env.servesAnExternalService };
  }

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
      this.appReadiness.markServing(key, projectId);
      if (changed) {
        await this.projectEventsService.publish(projectId);
      }
    } else if (serving) {
      this.appReadiness.markServing(key, projectId);
    } else {
      this.appReadiness.markDown(key);
    }
    if (serving || live) await this.doorbell.appStarted(key);

    return { ok: true };
  }
}
