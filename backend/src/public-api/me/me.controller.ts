import { Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowsGatewayCaller } from '../auth/allows-gateway-caller.decorator';
import { BuilderChatService } from '../../builder/builder-chat.service';
import { Caller, chatProjectIdOf } from '../auth/caller';
import { PublicApiController, PublicApiErrors, PublicResponse } from '../public-api.decorator';
import { MeMapper } from './me.mapper';
import { MeSchema, type MeDto } from './me.schema';

@ApiTags('Me')
@PublicApiController('me')
export class MeController {
  constructor(private readonly builderChats: BuilderChatService) {}

  @Get()
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Get the current user',
    description:
      "Who the token belongs to, where it can act, and what it may do. The id is the platform user id used everywhere else in this API, not the subject of your token. Organizations lists every Organization you belong to; organization is the one this call used. Permissions are the can_* names you hold, sorted.\n\n**Use it for** three things: proving a freshly minted token works, discovering which Organization to send as x-tenant-name when you belong to several, and hiding actions the caller cannot perform — check for can_delete_project before offering a delete rather than letting it fail with a 403.\n\nA Builder chat's pod also reads `builderSubject` here, the Skill or Agent it was opened on, and `builderTestProject`, its one Test Project once it has created it.",
  })
  @PublicResponse(200, MeSchema)
  @PublicApiErrors('unauthenticated', 'organization-required', 'organization-forbidden', 'permission-denied')
  async get(@Caller() caller: Caller): Promise<MeDto> {
    const chatId = chatProjectIdOf(caller);
    if (chatId === null) return MeMapper.toDto(caller, null, null);
    const [subject, testProject] = await Promise.all([
      this.builderChats.subjectOfChat(caller.organization.id, caller.user.platformId, chatId),
      this.builderChats.testProjectOf(caller.organization.id, chatId),
    ]);
    return MeMapper.toDto(caller, subject, testProject);
  }
}
