import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { AppUserLinksService } from '../app-users/app-user-links.service';
import { AppUserMailer } from '../app-users/app-user-mailer';
import { AppUserRolesService } from '../app-users/app-user-roles.service';
import { AppUsersService } from '../app-users/app-users.service';
import type {
  AppUserRoleDto,
  CreateAppUserDto,
  CreateAppUserLinkDto,
  UpdateAppUserDto,
} from '../app-users/app-users.types';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { ProjectService } from './project.service';

@Controller('projects/:id')
@RequirePermission('can_manage_project_auth_settings')
export class ProjectAppUsersController {
  constructor(
    private readonly appUsers: AppUsersService,
    private readonly roles: AppUserRolesService,
    private readonly links: AppUserLinksService,
    private readonly mailer: AppUserMailer,
    private readonly projectService: ProjectService,
    private readonly userService: UserService
  ) {}

  @Get('app-users')
  async list(@Param('id') id: string, @CurrentTenant() tenant: TenantContext, @CurrentUser() user: UserContext) {
    const projectId = await this.gate(id, tenant, user);
    const [users, roles] = await Promise.all([this.appUsers.list(projectId), this.roles.list(projectId)]);
    return { users, roles, email: this.mailer.enabled };
  }

  @Post('app-users')
  async create(
    @Param('id') id: string,
    @Body() dto: CreateAppUserDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    return this.appUsers.create(await this.gate(id, tenant, user), dto);
  }

  @Patch('app-users/:appUserId')
  async update(
    @Param('id') id: string,
    @Param('appUserId') appUserId: string,
    @Body() dto: UpdateAppUserDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    return this.appUsers.update(await this.gate(id, tenant, user), appUserId, dto ?? {});
  }

  @Delete('app-users/:appUserId')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Param('appUserId') appUserId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    await this.appUsers.remove(await this.gate(id, tenant, user), appUserId);
  }

  @Post('app-users/:appUserId/links')
  async createLink(
    @Param('id') id: string,
    @Param('appUserId') appUserId: string,
    @Body() dto: CreateAppUserLinkDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    return this.links.createForOwner(
      await this.gate(id, tenant, user),
      appUserId,
      dto?.purpose,
      dto?.environmentId,
      dto?.send
    );
  }

  @Post('app-user-roles')
  async createRole(
    @Param('id') id: string,
    @Body() dto: AppUserRoleDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    return this.roles.create(await this.gate(id, tenant, user), dto ?? {});
  }

  @Patch('app-user-roles/:roleId')
  async updateRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Body() dto: AppUserRoleDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    return this.roles.update(await this.gate(id, tenant, user), roleId, dto ?? {});
  }

  @Delete('app-user-roles/:roleId')
  @HttpCode(204)
  async removeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    await this.roles.remove(await this.gate(id, tenant, user), roleId);
  }

  private async gate(projectId: string, tenant: TenantContext, user: UserContext): Promise<string> {
    const userId = await this.userService.resolveUserId(user, tenant.tenantId);
    const project = await this.projectService.findOneForUser({ projectId, tenantId: tenant.tenantId, userId });
    return project.id;
  }
}
