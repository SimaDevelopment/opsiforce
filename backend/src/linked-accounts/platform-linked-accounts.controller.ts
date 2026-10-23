import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { AgentCallerRefusalGuard } from '../model-provider/agent-caller-refusal.guard';
import { RequirePermission } from '../permission/permission.guard';
import { PlatformScope } from '../tenant/tenant.decorator';
import type {
  LinkedAccountUsageView,
  LinkedAccountView,
  PastedAccessToken,
  StartedSignInView,
} from './linked-account.types';
import { LinkedAccountsService } from './linked-accounts.service';

@Controller('platform-model-providers')
@PlatformScope()
@RequirePermission('can_manage_platform_model_providers')
@UseGuards(AgentCallerRefusalGuard)
export class PlatformLinkedAccountsController {
  constructor(private readonly linkedAccountsService: LinkedAccountsService) {}

  @Post(':name/sign-in')
  @HttpCode(200)
  startSignIn(@Param('name') name: string): Promise<StartedSignInView> {
    return this.linkedAccountsService.startPlatformSignIn(name);
  }

  @Get(':name/linked-account')
  status(@Param('name') name: string): Promise<LinkedAccountView> {
    return this.linkedAccountsService.platformStatus(name);
  }

  @Get(':name/linked-account/usage')
  usage(@Param('name') name: string): Promise<LinkedAccountUsageView> {
    return this.linkedAccountsService.platformUsage(name);
  }

  @Post(':name/access-token')
  @HttpCode(200)
  pasteAccessToken(
    @Param('name') name: string,
    @Body() body: PastedAccessToken | undefined
  ): Promise<LinkedAccountView> {
    return this.linkedAccountsService.pastePlatformAccessToken(name, body?.accessToken);
  }

  @Post(':name/disconnect')
  @HttpCode(200)
  disconnect(@Param('name') name: string): Promise<LinkedAccountView> {
    return this.linkedAccountsService.disconnectPlatform(name);
  }
}
