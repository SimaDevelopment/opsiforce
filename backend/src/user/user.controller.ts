import { Body, Controller, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { RequirePermission } from '../permission/permission.guard';
import { Perms } from '../permission/permission.constants';
import { getGroupsHeader } from '../permission/permission.utils';
import { CurrentTenant, Public, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from './user.decorator';
import {
  UserService,
  type UpdateWorkspacePreferencesDto,
  type UserRecord,
  type WorkspacePreferencesResponse,
} from './user.service';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @RequirePermission(Perms.manageWorkspaces)
  listUsers(@CurrentTenant() tenant: TenantContext): Promise<UserRecord[]> {
    return this.userService.listByTenant(tenant.tenantId);
  }

  @Public()
  @Post('last-access-times')
  async getLastAccessTimes(
    @Body() body: { keycloakUserIds?: string[] }
  ): Promise<{ lastAccessTimes: Record<string, string | null> }> {
    const keycloakUserIds = Array.isArray(body?.keycloakUserIds) ? body.keycloakUserIds : [];
    const lastAccessTimes = await this.userService.getLastAccessTimes(keycloakUserIds);
    return { lastAccessTimes };
  }

  @Post('me')
  async getOrCreateMe(@Req() req: FastifyRequest, @CurrentTenant() tenant: TenantContext): Promise<UserRecord> {
    const keycloakId = req.headers['x-forwarded-user'] as string | undefined;
    if (!keycloakId) {
      throw new UnauthorizedException('Missing x-forwarded-user header');
    }
    const email = req.headers['x-forwarded-email'] as string | undefined;
    const displayName = req.headers['x-forwarded-preferred-username'] as string | undefined;
    const groups = getGroupsHeader(req);
    return this.userService.getOrCreateUser({ keycloakId, email, displayName, groups }, tenant.tenantId);
  }

  @Get('me')
  async getMe(@CurrentUser() user: UserContext, @CurrentTenant() tenant: TenantContext): Promise<UserRecord> {
    return this.ensureDbUser(user, tenant.tenantId);
  }

  @Get('me/workspace-preferences')
  async getWorkspacePreferences(
    @CurrentUser() user: UserContext,
    @CurrentTenant() tenant: TenantContext
  ): Promise<WorkspacePreferencesResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.userService.getWorkspacePreferences(dbUser.id);
  }

  @Patch('me/workspace-preferences')
  async updateWorkspacePreferences(
    @CurrentUser() user: UserContext,
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: UpdateWorkspacePreferencesDto
  ): Promise<WorkspacePreferencesResponse> {
    const dbUser = await this.ensureDbUser(user, tenant.tenantId);
    return this.userService.updateWorkspacePreferences(dbUser.id, dto);
  }

  @Get(':id')
  @RequirePermission(Perms.manageWorkspaces)
  findOne(@Param('id') id: string): Promise<UserRecord> {
    return this.userService.findById(id);
  }

  private ensureDbUser(user: UserContext, tenantId: string): Promise<UserRecord> {
    return this.userService.getOrCreateUser(
      {
        keycloakId: user.userId,
        email: user.email ?? undefined,
        displayName: user.displayName ?? undefined,
        groups: user.groups,
      },
      tenantId
    );
  }
}
