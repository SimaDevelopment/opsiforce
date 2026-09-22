import { Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Caller } from '../auth/caller';
import { PublicApiController, PublicApiErrors, PublicResponse } from '../public-api.decorator';
import { MeMapper } from './me.mapper';
import { MeSchema, type MeDto } from './me.schema';

@ApiTags('Me')
@PublicApiController('me')
export class MeController {
  @Get()
  @ApiOperation({
    summary: 'Get the current user',
    description:
      'Who the token belongs to, where it can act, and what it may do. The id is the platform user id used everywhere else in this API, not the subject of your token. Organizations lists every Organization you belong to; organization is the one this call used. Permissions are the can_* names you hold, sorted.\n\n**Use it for** three things: proving a freshly minted token works, discovering which Organization to send as x-tenant-name when you belong to several, and hiding actions the caller cannot perform — check for can_delete_project before offering a delete rather than letting it fail with a 403.',
  })
  @PublicResponse(200, MeSchema)
  @PublicApiErrors('unauthenticated', 'organization-required', 'organization-forbidden', 'permission-denied')
  get(@Caller() caller: Caller): MeDto {
    return MeMapper.toDto(caller);
  }
}
