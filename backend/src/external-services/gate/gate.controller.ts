import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { inputBytesOf } from '@opsiforce/external-service-sdk/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../tenant/tenant.decorator';
import { ExternalServiceGate } from './external-service-gate';
import type { GateCallerSource } from './gate-caller';
import { bearerTokenOf, GATE_MOUNT, VIA_HEADER, viaOf } from './gate-routes';
import { GateSurfaces, type SurfaceAnswer } from './gate-surfaces';
import { sendGateAnswer } from './service-answers';

function keyOf(request: FastifyRequest): GateCallerSource {
  return { serviceKey: bearerTokenOf(request.headers.authorization) };
}

export function inputBytesOfRequest(request: FastifyRequest, body: unknown): number {
  const declared = Number(request.headers['content-length']);
  return Number.isFinite(declared) && declared > 0 ? declared : inputBytesOf(body);
}

@Public()
@Controller(GATE_MOUNT)
export class ExternalServiceGateController {
  constructor(
    private readonly gate: ExternalServiceGate,
    private readonly surfaces: GateSurfaces
  ) {}

  @Get(':slug')
  async describe(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @Param('slug') slug: string) {
    await this.send(reply, await this.surfaces.describe(keyOf(request), slug));
  }

  @Get(':slug/openapi.json')
  async openApi(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @Param('slug') slug: string) {
    const ifNoneMatch = request.headers['if-none-match'];
    await this.send(reply, await this.surfaces.openApi(keyOf(request), slug, ifNoneMatch));
  }

  @Get(':slug/calls')
  async recentCalls(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('slug') slug: string,
    @Query('limit') limit: string | undefined
  ) {
    await this.send(reply, await this.surfaces.recentCalls(keyOf(request), slug, limit));
  }

  @Post(':slug/:operation')
  async callOperation(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('slug') slug: string,
    @Param('operation') operation: string,
    @Body() body: unknown
  ): Promise<void> {
    const answer = await this.gate.callOperation({
      from: keyOf(request),
      slug,
      operation,
      input: body ?? {},
      inputBytes: inputBytesOfRequest(request, body),
      via: viaOf(request.headers[VIA_HEADER]),
    });
    await sendGateAnswer(reply, answer);
  }

  private async send(reply: FastifyReply, answer: SurfaceAnswer): Promise<void> {
    await reply.status(answer.status).headers(answer.headers).send(answer.body);
  }
}
