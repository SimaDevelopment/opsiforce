import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { RequirePermission } from '../permission/permission.guard';
import { getGroupsHeader, hasPermission } from '../permission/permission.utils';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService, type UserRecord } from '../user/user.service';
import type { ProjectResponse } from '../project/project.types';
import { WorkspaceService } from './workspace.service';
import type {
  AddWorkspaceMemberDto,
  AssignProjectDto,
  CreateFolderDto,
  CreateProjectInWorkspaceDto,
  CreateWorkspaceDto,
  FolderResponse,
  MoveFolderDto,
  RenameFolderDto,
  UpdateWorkspaceDto,
  WorkspaceResponse,
} from './workspace.types';

function readPerms(req: FastifyRequest) {
  const groups = getGroupsHeader(req);
  return {
    canManageWorkspaces: hasPermission(groups, 'can_manage_workspaces'),
    canMoveProjectsBetweenWorkspaces: hasPermission(groups, 'can_move_projects_between_workspaces'),
  };
}

@Controller('workspaces')
export class WorkspaceController {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly userService: UserService
  ) {}

  @Get()
  async findAll(
    @Query('scope') scope: string | undefined,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<WorkspaceResponse[]> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    if (scope === 'all') {
      if (!readPerms(req).canManageWorkspaces) {
        throw new ForbiddenException('Missing permission: can_manage_workspaces');
      }
      return this.workspaceService.findAllForAdmin(tenant.tenantId, dbUser.id);
    }
    return this.workspaceService.findAll({
      userId: dbUser.id,
      tenantId: tenant.tenantId,
    });
  }

  @Post()
  @RequirePermission('can_manage_workspaces')
  async create(
    @Body() dto: CreateWorkspaceDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<WorkspaceResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.create(dto, tenant.tenantId, dbUser.id);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<WorkspaceResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.findOne({
      workspaceId: id,
      userId: dbUser.id,
      tenantId: tenant.tenantId,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
    });
  }

  @Patch(':id')
  @RequirePermission('can_manage_workspaces')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkspaceDto,
    @CurrentTenant() tenant: TenantContext
  ): Promise<WorkspaceResponse> {
    return this.workspaceService.update(id, dto, tenant.tenantId);
  }

  @Delete(':id')
  @RequirePermission('can_manage_workspaces')
  async remove(@Param('id') id: string, @CurrentTenant() tenant: TenantContext): Promise<void> {
    await this.workspaceService.remove(id, tenant.tenantId);
  }

  @Get(':id/members')
  async listMembers(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<UserRecord[]> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.listMembers({
      workspaceId: id,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
    });
  }

  @Post(':id/members')
  @RequirePermission('can_manage_workspaces')
  async addMember(
    @Param('id') id: string,
    @Body() dto: AddWorkspaceMemberDto,
    @CurrentTenant() tenant: TenantContext
  ): Promise<void> {
    await this.workspaceService.addMember(id, dto.userId, tenant.tenantId);
  }

  @Delete(':id/members/:userId')
  @RequirePermission('can_manage_workspaces')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentTenant() tenant: TenantContext
  ): Promise<void> {
    await this.workspaceService.removeMember(id, userId, tenant.tenantId);
  }

  @Get(':id/folders')
  async listFolders(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<FolderResponse[]> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.listFolders({
      workspaceId: id,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
    });
  }

  @Post(':id/folders')
  async createFolder(
    @Param('id') id: string,
    @Body() dto: CreateFolderDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<FolderResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.createFolder({
      workspaceId: id,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
      dto,
    });
  }

  @Patch(':id/folders/:folderId')
  async renameFolder(
    @Param('id') id: string,
    @Param('folderId') folderId: string,
    @Body() dto: RenameFolderDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<FolderResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.renameFolder({
      workspaceId: id,
      folderId,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
      dto,
    });
  }

  @Post(':id/folders/:folderId/move')
  async moveFolder(
    @Param('id') id: string,
    @Param('folderId') folderId: string,
    @Body() dto: MoveFolderDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<FolderResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.moveFolder({
      workspaceId: id,
      folderId,
      toWorkspaceId: dto.toWorkspaceId,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      ...readPerms(req),
    });
  }

  @Delete(':id/folders/:folderId')
  async deleteFolder(
    @Param('id') id: string,
    @Param('folderId') folderId: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    await this.workspaceService.deleteFolder({
      workspaceId: id,
      folderId,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
    });
  }

  @Get(':id/projects')
  async listProjects(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectResponse[]> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.listProjects({
      workspaceId: id,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
    });
  }

  @Post(':id/projects')
  async createProjectInWorkspace(
    @Param('id') id: string,
    @Body() dto: CreateProjectInWorkspaceDto | undefined,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.createProjectInWorkspace({
      workspaceId: id,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      canManageWorkspaces: readPerms(req).canManageWorkspaces,
      dto,
      folderId: dto?.folderId ?? null,
    });
  }

  @Post(':id/projects/:projectId')
  async assignProject(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @Body() dto: AssignProjectDto | undefined,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.assignProject({
      workspaceId: id,
      projectId,
      folderId: dto ? dto.folderId : undefined,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      ...readPerms(req),
    });
  }

  @Delete(':id/projects/:projectId')
  @RequirePermission('can_manage_workspaces')
  async unassignProject(
    @Param('id') _id: string,
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.workspaceService.assignProject({
      workspaceId: null,
      projectId,
      tenantId: tenant.tenantId,
      userId: dbUser.id,
      ...readPerms(req),
    });
  }

  /** Keycloak sub → DB user row. Handlers need the uuid for FK references. */
  private ensureDbUser(user: UserContext, tenantId: string): Promise<UserRecord> {
    return this.userService.getOrCreateUser(
      {
        keycloakId: user.userId,
        email: user.email ?? undefined,
        displayName: user.displayName ?? undefined,
      },
      tenantId
    );
  }
}
