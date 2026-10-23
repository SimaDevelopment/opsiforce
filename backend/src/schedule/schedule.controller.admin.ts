import { Controller, Get, Patch, Post, Delete, Param, Query, Body } from '@nestjs/common';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { RequirePermission } from '../permission/permission.guard';
import { ScheduleService } from './schedule.service';
import type { UpdateScheduleDto } from './schedule.types';

@Controller()
@RequirePermission('can_manage_schedules')
export class ScheduleAdminController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Get('schedules')
  findAll(
    @CurrentTenant() tenant: TenantContext,
    @Query('environmentId') environmentId?: string,
    @Query('projectEnvironmentId') projectEnvironmentId?: string
  ) {
    return this.scheduleService.findByTenant(tenant.tenantId, { environmentId, projectEnvironmentId });
  }

  @Patch('projects/:projectId/schedules/:scheduleId')
  update(
    @Param('scheduleId') scheduleId: string,
    @Body() dto: UpdateScheduleDto,
    @CurrentTenant() tenant: TenantContext
  ) {
    return this.scheduleService.update(scheduleId, tenant.tenantId, dto);
  }

  @Post('projects/:projectId/schedules/:scheduleId/run')
  async triggerRun(@Param('scheduleId') scheduleId: string, @CurrentTenant() tenant: TenantContext) {
    await this.scheduleService.findOne(scheduleId, tenant.tenantId);
    await this.scheduleService.triggerNow(scheduleId);
    return { success: true };
  }

  @Delete('projects/:projectId/schedules/:scheduleId')
  async remove(@Param('scheduleId') scheduleId: string, @CurrentTenant() tenant: TenantContext) {
    await this.scheduleService.remove(scheduleId, tenant.tenantId);
    return { success: true };
  }

  @Get('projects/:projectId/schedules/:scheduleId/executions')
  async getExecutions(
    @Param('scheduleId') scheduleId: string,
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: string
  ) {
    await this.scheduleService.findOne(scheduleId, tenant.tenantId);
    return this.scheduleService.getExecutions(scheduleId, limit ? parseInt(limit, 10) : 50);
  }
}
