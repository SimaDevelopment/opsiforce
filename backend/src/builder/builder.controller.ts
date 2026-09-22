import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Perms } from '../permission/permission.constants';
import { RequireAnyPermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { BuilderChatService } from './builder-chat.service';
import type {
  BuilderChatCaller,
  BuilderChatCreated,
  BuilderChatFilter,
  BuilderChatSummary,
  CreateBuilderChatDto,
  SetChatVisibilityDto,
} from './builder.types';

@Controller('builder')
@RequireAnyPermission([Perms.manageSkills, Perms.manageAgents])
export class BuilderController {
  constructor(
    private readonly chats: BuilderChatService,
    private readonly userService: UserService
  ) {}

  @Get('chats')
  async list(
    @Query('filter') filter: BuilderChatFilter | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<BuilderChatSummary[]> {
    return this.chats.list(await this.caller(tenant, user), filter ?? 'active');
  }

  @Get('chats/:id')
  async open(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<BuilderChatSummary> {
    return this.chats.open(await this.caller(tenant, user), id);
  }

  @Post('chats')
  async create(
    @Body() dto: CreateBuilderChatDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<BuilderChatCreated> {
    return this.chats.create(await this.caller(tenant, user), dto);
  }

  @Post('chats/:id/visibility')
  async setVisibility(
    @Param('id') id: string,
    @Body() dto: SetChatVisibilityDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<BuilderChatSummary> {
    return this.chats.setVisibility(await this.caller(tenant, user), id, dto?.visibility);
  }

  @Post('chats/:id/archive')
  async archive(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<BuilderChatSummary> {
    return this.chats.archive(await this.caller(tenant, user), id);
  }

  @Post('chats/:id/restore')
  async restore(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<BuilderChatSummary> {
    return this.chats.restore(await this.caller(tenant, user), id);
  }

  @Delete('chats/:id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    await this.chats.remove(await this.caller(tenant, user), id);
  }

  @Delete('chats/:id/test-project')
  @HttpCode(204)
  async removeTestProject(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    await this.chats.removeTestProject(await this.caller(tenant, user), id);
  }

  private async caller(tenant: TenantContext, user: UserContext): Promise<BuilderChatCaller> {
    return { tenantId: tenant.tenantId, userId: await this.userService.resolveUserId(user, tenant.tenantId) };
  }
}
