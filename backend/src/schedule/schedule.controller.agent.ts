import { Controller, Post, Get, Delete, Body, Param, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { Public } from '../tenant/tenant.decorator';
import { GatewayAuthGuard } from '../gateway/gateway-auth.guard';
import { ScheduleService } from './schedule.service';
import type { GatewayRequest } from '../gateway/gateway-key.service';
import type { CreateScheduleDto } from './schedule.types';

@Public()
@UseGuards(GatewayAuthGuard)
@Controller('gateway/schedules')
export class ScheduleAgentController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Post()
  async upsert(@Body() dto: CreateScheduleDto, @Req() req: GatewayRequest) {
    const { projectId, projectEnvironmentId, tenantId } = req.gatewayContext;

    if (!dto.name || !dto.cronPattern || !dto.targetPath) {
      throw new BadRequestException('Missing required fields: name, cronPattern, targetPath');
    }

    if (!tenantId) {
      throw new BadRequestException('Schedules require a claimed project');
    }

    return this.scheduleService.upsert(projectId, projectEnvironmentId ?? projectId, tenantId, dto);
  }

  @Get()
  async list(@Req() req: GatewayRequest) {
    const { projectId, projectEnvironmentId } = req.gatewayContext;
    return this.scheduleService.findByEnvironment(projectEnvironmentId ?? projectId);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: GatewayRequest) {
    const { projectId, projectEnvironmentId } = req.gatewayContext;
    await this.scheduleService.removeByEnvironment(projectEnvironmentId ?? projectId, id);
    return { success: true };
  }
}
