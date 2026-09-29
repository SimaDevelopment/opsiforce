import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { contentDisposition } from '../files/file-content-types';
import { Perms } from '../permission/permission.constants';
import { RelaxPermission, RequirePermission } from '../permission/permission.guard';
import { getGroupsHeader, hasPermission } from '../permission/permission.utils';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { MissingPermissionException } from '../permission/missing-permission.exception';
import { ProjectImportUploadService } from '../project/project-import-upload.service';
import { ProjectService } from '../project/project.service';
import { UserService } from '../user/user.service';
import type { AgentExportPreview } from './agent-export';
import { AgentExportService } from './agent-export.service';
import type { AgentImportResult, ImportAgentDto } from './agent-import';
import { AgentImportService } from './agent-import.service';
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
    private readonly exportService: AgentExportService,
    private readonly importService: AgentImportService,
    private readonly uploadService: ProjectImportUploadService,
    private readonly userService: UserService,
    private readonly projectService: ProjectService
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

  @Post('import')
  async import(
    @Body() dto: ImportAgentDto | undefined,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentImportResult> {
    if (!hasPermission(getGroupsHeader(req), Perms.manageSkills)) {
      throw new MissingPermissionException(Perms.manageSkills);
    }
    const uploadId = dto?.uploadId?.trim();
    if (!uploadId) throw new BadRequestException('An "uploadId" from a chunked upload session is required');

    const caller = await this.caller(req, tenant, user);
    const archivePath = join(this.uploadService.stagingRoot(), `.agent-import-${randomUUID()}.zip`);
    try {
      return await this.uploadService.consumeUpload({ tenantId: tenant.tenantId, uploadId }, archivePath, () =>
        this.importService.import(caller, archivePath, dto?.displayName ?? null)
      );
    } finally {
      await rm(archivePath, { force: true }).catch(() => {});
    }
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

  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    const exported = await this.exportService.export(await this.caller(req, tenant, user), id);
    await reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', exported.archive.byteLength)
      .header('Content-Disposition', contentDisposition(exported.fileName, 'attachment'))
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(exported.archive);
  }

  @Get(':id/export/preview')
  async exportPreview(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentExportPreview> {
    return this.exportService.preview(await this.caller(req, tenant, user), id);
  }

  @Post(':id/disable')
  async disable(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.setDisabled(await this.caller(req, tenant, user), id, true);
  }

  @Post(':id/enable')
  async enable(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<AgentDetail> {
    return this.agentService.setDisabled(await this.caller(req, tenant, user), id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    await this.agentService.remove(await this.caller(req, tenant, user), id, async (projectIds) => {
      for (const projectId of projectIds) await this.projectService.remove(projectId, tenant.tenantId);
    });
  }

  private async caller(req: FastifyRequest, tenant: TenantContext, user: UserContext): Promise<AgentCaller> {
    return {
      tenantId: tenant.tenantId,
      userId: await this.userService.resolveUserId(user, tenant.tenantId),
      canManageAgents: hasPermission(getGroupsHeader(req), Perms.manageAgents),
    };
  }
}
