import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Perms } from '../permission/permission.constants';
import { RelaxPermission, RequirePermission } from '../permission/permission.guard';
import { getGroupsHeader, hasPermission } from '../permission/permission.utils';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { modelCatalogResponse, type ModelCatalogProvider } from './agent-models';
import { AgentService } from './agent.service';
import type {
  AgentCaller,
  AgentDeliveryResponse,
  AgentDetail,
  AgentProfileSkillResponse,
  AgentResponse,
  AgentSummary,
  CreateAgentDto,
  DuplicateAgentDto,
  PublishAgentDto,
  PublishAgentResponse,
  SetAgentSkillDto,
  SetAgentVisibilityDto,
  UpdateAgentDto,
  UpdateAgentProfileDto,
  UpdateAgentSettingsDto,
} from './agent.types';

@Controller('agents')
@RequirePermission(Perms.manageAgents)
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly userService: UserService
  ) {}

  @Get()
  @RelaxPermission()
  async findAll(
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentResponse[]> {
    return this.agentService.findAll(await this.caller(req, tenant, user));
  }

  @Get('store')
  @RelaxPermission()
  async listStore(
    @Query('filter') filter: string | undefined,
    @Query('q') query: string | undefined,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentSummary[]> {
    return this.agentService.listStore(await this.caller(req, tenant, user), filter, query);
  }

  @Get('models')
  @RelaxPermission()
  models(): ModelCatalogProvider[] {
    return modelCatalogResponse();
  }

  @Get(':id')
  @RelaxPermission()
  async findOne(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.findOne(await this.caller(req, tenant, user), id);
  }

  @Get(':id/skills')
  @RelaxPermission()
  async listSkills(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentProfileSkillResponse[]> {
    return this.agentService.listSkills(await this.caller(req, tenant, user), id);
  }

  @Get(':id/delivery')
  @RelaxPermission()
  async delivery(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDeliveryResponse> {
    return this.agentService.delivery(await this.caller(req, tenant, user), id);
  }

  @Post()
  async create(
    @Body() dto: CreateAgentDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.create(await this.caller(req, tenant, user), dto);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.update(await this.caller(req, tenant, user), id, dto);
  }

  @Put(':id/profile')
  async updateProfile(
    @Param('id') id: string,
    @Body() dto: UpdateAgentProfileDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.updateProfile(await this.caller(req, tenant, user), id, dto);
  }

  @Put(':id/settings')
  async updateSettings(
    @Param('id') id: string,
    @Body() dto: UpdateAgentSettingsDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.updateSettings(await this.caller(req, tenant, user), id, dto);
  }

  @Put(':id/skills/:skillId')
  async setSkill(
    @Param('id') id: string,
    @Param('skillId') skillId: string,
    @Body() dto: SetAgentSkillDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentProfileSkillResponse[]> {
    return this.agentService.setSkill(await this.caller(req, tenant, user), id, skillId, dto ?? {});
  }

  @Delete(':id/skills/:skillId')
  async removeSkill(
    @Param('id') id: string,
    @Param('skillId') skillId: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentProfileSkillResponse[]> {
    return this.agentService.removeSkill(await this.caller(req, tenant, user), id, skillId);
  }

  @Post(':id/publish')
  @HttpCode(200)
  async publish(
    @Param('id') id: string,
    @Body() dto: PublishAgentDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<PublishAgentResponse> {
    return this.agentService.publish(await this.caller(req, tenant, user), id, dto);
  }

  @Post(':id/visibility')
  async setVisibility(
    @Param('id') id: string,
    @Body() dto: SetAgentVisibilityDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.setVisibility(await this.caller(req, tenant, user), id, dto);
  }

  @Post(':id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Body() dto: DuplicateAgentDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.duplicate(await this.caller(req, tenant, user), id, dto);
  }

  @Post(':id/archive')
  async archive(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.setArchived(await this.caller(req, tenant, user), id, true);
  }

  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.setArchived(await this.caller(req, tenant, user), id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    await this.agentService.remove(await this.caller(req, tenant, user), id);
  }

  private async caller(req: FastifyRequest, tenant: TenantContext, user: UserContext): Promise<AgentCaller> {
    return {
      tenantId: tenant.tenantId,
      userId: await this.userService.resolveUserId(user, tenant.tenantId),
      canManageAgents: hasPermission(getGroupsHeader(req), Perms.manageAgents),
    };
  }
}
