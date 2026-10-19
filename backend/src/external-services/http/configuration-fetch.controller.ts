import { Controller, Get, Headers, Res } from '@nestjs/common';
import { callerIdentityHeader } from '@opsiforce/external-service-sdk/server';
import type { FastifyReply } from 'fastify';
import { Public } from '../../tenant/tenant.decorator';
import { ConfigurationFetch, ConfigurationFetchRefused } from '../configuration/configuration-fetch';
import { bearerTokenOf } from '../gate/gate-routes';

@Public()
@Controller('gateway/configuration')
export class ConfigurationFetchController {
  constructor(private readonly fetch: ConfigurationFetch) {}

  @Get()
  async configuration(
    @Headers('authorization') authorization: string | undefined,
    @Headers(callerIdentityHeader) callerIdentity: string | undefined,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.answer(reply, () => this.fetch.forPod(bearerTokenOf(authorization), callerIdentity));
  }

  @Get('projects')
  async projectConfigurations(
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.answer(reply, async () => ({
      projectConfigurations: await this.fetch.projectConfigurationsFor(bearerTokenOf(authorization)),
    }));
  }

  private async answer(reply: FastifyReply, read: () => Promise<unknown>): Promise<void> {
    try {
      await reply.header('cache-control', 'no-store').send(await read());
    } catch (error) {
      if (!(error instanceof ConfigurationFetchRefused)) throw error;
      await reply.status(error.status).send({ message: error.message });
    }
  }
}
