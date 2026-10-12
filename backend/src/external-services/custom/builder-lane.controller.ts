import { Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseFilters } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../tenant/tenant.decorator';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import { sendProblem } from '../http/problem-reply';
import { ExternalServiceGate } from '../gate/external-service-gate';
import { FormCalls, formCallRouteOf } from '../gate/form-calls';
import { inputBytesOfRequest } from '../gate/gate.controller';
import { GateRefusal, refuse } from '../gate/gate-refusals';
import { bearerTokenOf, GATE_MOUNT, VIA_HEADER, viaOf } from '../gate/gate-routes';
import { GateSurfaces, type SurfaceAnswer } from '../gate/gate-surfaces';
import { sendGateAnswer } from '../gate/service-answers';
import { BuilderLane, type BuilderChat } from './builder-lane';

const BUILDER_LANE_PATH = `${GATE_MOUNT}/_builder`;

@Public()
@Controller(BUILDER_LANE_PATH)
@UseFilters(InvalidConfigurationFilter)
export class BuilderLaneController {
  constructor(
    private readonly lane: BuilderLane,
    private readonly gate: ExternalServiceGate,
    private readonly surfaces: GateSurfaces,
    private readonly formCalls: FormCalls
  ) {}

  @Get()
  async view(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.answer(reply, async (chat) => this.lane.view(chat), request);
  }

  @Post('test-project')
  async createTestProject(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Body() body: { agentId?: unknown; title?: unknown } | undefined
  ): Promise<void> {
    await this.answer(reply, (chat) => this.lane.createTestProject(chat, body ?? {}), request, 201);
  }

  @Post('test-project/update')
  async update(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.answer(reply, (chat) => this.lane.update(chat), request, 204);
  }

  @Post('test-project/reset')
  async reset(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.answer(reply, (chat) => this.lane.reset(chat), request, 204);
  }

  @Get('test-project/configuration')
  async configuration(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.answer(reply, (chat) => this.lane.configuration(chat), request);
  }

  @Put('test-project/configuration')
  async saveConfiguration(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Body() body: { values?: unknown } | undefined
  ): Promise<void> {
    await this.answer(reply, (chat) => this.lane.saveConfiguration(chat, body?.values), request);
  }

  @Get('test-project/events')
  async events(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('limit') limit: string | undefined
  ): Promise<void> {
    await this.answer(reply, (chat) => this.lane.events(chat, limit), request);
  }

  @Get('probe')
  async describe(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.probeSurface(request, reply, (from, slug) => this.surfaces.describe(from, slug));
  }

  @Get('probe/openapi.json')
  async openApi(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.probeSurface(request, reply, (from, slug) =>
      this.surfaces.openApi(from, slug, request.headers['if-none-match'])
    );
  }

  @Get('probe/calls')
  async recentCalls(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('limit') limit: string | undefined
  ): Promise<void> {
    await this.probeSurface(request, reply, (from, slug) => this.surfaces.recentCalls(from, slug, limit));
  }

  @Post('probe/:operation')
  async callOperation(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('operation') operation: string,
    @Body() body: unknown
  ): Promise<void> {
    let chat: BuilderChat;
    let caller;
    try {
      chat = await this.lane.chatOf(bearerTokenOf(request.headers.authorization));
      caller = await this.lane.testProjectCaller(chat);
    } catch (error) {
      await this.sendRefusal(reply, error);
      return;
    }
    const answer = await this.gate.callOperation({
      from: { caller },
      slug: chat.slug,
      operation,
      input: body ?? {},
      inputBytes: inputBytesOfRequest(request, body),
      via: viaOf(request.headers[VIA_HEADER]),
    });
    await sendGateAnswer(reply, answer);
  }

  @Post('probe/:route/:name')
  async callForm(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown
  ): Promise<void> {
    try {
      const formCallRoute = formCallRouteOf(route);
      if (!formCallRoute) {
        refuse({
          status: 404,
          code: 'unknown-form-call',
          detail: `Form calls are options, info or buttons, not ${route}.`,
        });
      }
      const chat = await this.lane.chatOf(bearerTokenOf(request.headers.authorization));
      const target = await this.lane.formCallTarget(chat);
      await sendGateAnswer(reply, await this.formCalls.callProjectForm({ target, route: formCallRoute, name, body }));
    } catch (error) {
      await this.sendRefusal(reply, error);
    }
  }

  private async probeSurface(
    request: FastifyRequest,
    reply: FastifyReply,
    surface: (
      from: { caller: Awaited<ReturnType<BuilderLane['testProjectCaller']>> },
      slug: string
    ) => Promise<SurfaceAnswer>
  ): Promise<void> {
    try {
      const chat = await this.lane.chatOf(bearerTokenOf(request.headers.authorization));
      const caller = await this.lane.testProjectCaller(chat);
      const answer = await surface({ caller }, chat.slug);
      await reply.status(answer.status).headers(answer.headers).send(answer.body);
    } catch (error) {
      await this.sendRefusal(reply, error);
    }
  }

  private async answer<T>(
    reply: FastifyReply,
    run: (chat: BuilderChat) => Promise<T>,
    request: FastifyRequest,
    status = 200
  ): Promise<void> {
    try {
      const chat = await this.lane.chatOf(bearerTokenOf(request.headers.authorization));
      const body = await run(chat);
      if (status === 204) await reply.status(204).send();
      else await reply.status(status).header('content-type', 'application/json; charset=utf-8').send(body);
    } catch (error) {
      await this.sendRefusal(reply, error);
    }
  }

  private async sendRefusal(reply: FastifyReply, error: unknown): Promise<void> {
    if (!(error instanceof GateRefusal)) throw error;
    await sendProblem(reply, error.refusal, error.headers);
  }
}
