import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RequireAnyPermission } from '../permission/permission.guard';
import { getGroupsHeader, hasPermission } from '../permission/permission.utils';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { BuilderChatService } from './builder-chat.service';
import type { BuilderChatCaller, BuilderChatSummary, BuilderSubjectRef } from './builder.types';

@Controller('builder')
@RequireAnyPermission(['can_manage_skills', 'can_manage_agents', 'can_manage_tenant_external_services'])
export class BuilderController {
  constructor(
    private readonly chats: BuilderChatService,
    private readonly userService: UserService
  ) {}

  @Post('chats')
  @HttpCode(200)
  async open(
    @Body() ref: BuilderSubjectRef,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<BuilderChatSummary> {
    return this.chats.openFor(await this.caller(req, tenant, user), ref);
  }

  private async caller(req: FastifyRequest, tenant: TenantContext, user: UserContext): Promise<BuilderChatCaller> {
    const groups = getGroupsHeader(req);
    return {
      tenantId: tenant.tenantId,
      userId: await this.userService.resolveUserId(user, tenant.tenantId),
      canManageSkills: hasPermission(groups, 'can_manage_skills'),
      canManageAgents: hasPermission(groups, 'can_manage_agents'),
      canManageTenantExternalServices: hasPermission(groups, 'can_manage_tenant_external_services'),
    };
  }
}
