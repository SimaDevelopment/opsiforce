import { Body, Get, HttpException, HttpStatus, Module, NotFoundException, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PublicApiController, PublicApiErrors, PublicResponse } from '../../../src/public-api/public-api.decorator';
import { Errors } from '../../../src/public-api/errors/public-api-error';

export const ProbeBodySchema = z.strictObject({ name: z.string() }).meta({ id: 'ProbeBody' });
export const ProbeQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(10) });
export const ProbeReplySchema = z.strictObject({ name: z.string() }).meta({ id: 'ProbeReply' });
export const ProbeNonEmptyReplySchema = z.strictObject({ name: z.string().min(1) }).meta({ id: 'ProbeNonEmptyReply' });

type ProbeBody = z.infer<typeof ProbeBodySchema>;
type ProbeQuery = z.infer<typeof ProbeQuerySchema>;
type ProbeReply = z.infer<typeof ProbeReplySchema>;

@PublicApiController('probe')
export class ProbeController {
  @Post('echo')
  @PublicResponse(200, ProbeReplySchema)
  @PublicApiErrors('validation-error')
  echo(@Body({ schema: ProbeBodySchema }) body: ProbeBody): ProbeReply {
    return body;
  }

  @Get('paged')
  @PublicResponse(200, ProbeReplySchema)
  @PublicApiErrors('validation-error')
  paged(@Query({ schema: ProbeQuerySchema }) query: ProbeQuery): ProbeReply {
    return { name: String(query.limit) };
  }

  @Post('unvalidated')
  @PublicResponse(200, ProbeReplySchema)
  unvalidated(@Body() body: ProbeBody): ProbeReply {
    return body;
  }

  @Get('unserializable')
  @PublicResponse(200, ProbeNonEmptyReplySchema)
  unserializable(): ProbeReply {
    return { name: '' };
  }

  @Get('foreign')
  @PublicResponse(200, ProbeReplySchema)
  @PublicApiErrors('not-found')
  foreign(): ProbeReply {
    throw new NotFoundException('the widget is gone');
  }

  @Get('unmapped')
  @PublicResponse(200, ProbeReplySchema)
  unmapped(): ProbeReply {
    throw new HttpException('payload too large', HttpStatus.PAYLOAD_TOO_LARGE);
  }

  @Get('catalogue')
  @PublicResponse(200, ProbeReplySchema)
  @PublicApiErrors('environment-starting')
  catalogue(): ProbeReply {
    throw Errors.environmentStarting();
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
