import { Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseFilters } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../tenant/tenant.decorator';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import { sendProblem } from '../http/problem-reply';
import { FormCalls, formCallRouteOf, type FormCallRoute } from '../gate/form-calls';
import { GateRefusal, refuse } from '../gate/gate-refusals';
import { bearerTokenOf } from '../gate/gate-routes';
import { sendGateAnswer } from '../gate/service-answers';
import { BuilderLane, type BuilderChat } from './builder-lane';

const BUILDER_LANE_PATH = 'gateway/_builder';

function requiredFormCallRoute(route: string): FormCallRoute {
  const formCallRoute = formCallRouteOf(route);
  if (!formCallRoute) {
    refuse({
      status: 404,
      code: 'unknown-form-call',
      detail: `Form calls are options, info or buttons, not ${route}.`,
    });
  }
  return formCallRoute;
}

@Public()
@Controller(BUILDER_LANE_PATH)
@UseFilters(InvalidConfigurationFilter)
export class BuilderLaneController {
  constructor(
    private readonly lane: BuilderLane,
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

  @Post('probe/service/:route/:name')
  async callServiceForm(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown
  ): Promise<void> {
    try {
      const formCallRoute = requiredFormCallRoute(route);
      const chat = await this.lane.chatOf(bearerTokenOf(request.headers.authorization));
      const development = await this.lane.servableDevelopment(chat);
      await sendGateAnswer(
        reply,
        await this.formCalls.callDevelopmentServiceForm({ development, route: formCallRoute, name, body })
      );
    } catch (error) {
      await this.sendRefusal(reply, error);
    }
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
      const formCallRoute = requiredFormCallRoute(route);
      const chat = await this.lane.chatOf(bearerTokenOf(request.headers.authorization));
      const target = await this.lane.formCallTarget(chat);
      await sendGateAnswer(reply, await this.formCalls.callProjectForm({ target, route: formCallRoute, name, body }));
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
