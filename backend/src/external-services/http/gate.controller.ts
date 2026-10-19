import { Body, Controller, ForbiddenException, Headers, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { Public } from '../../tenant/tenant.decorator';
import { CallerResolutions } from '../gate/caller-resolution';

interface ResolveBody {
  credential?: unknown;
  slug?: unknown;
}

interface ResolveWebhookBody {
  service?: unknown;
  development?: unknown;
}

@Public()
@Controller('internal/proxy/external-services')
export class GateController {
  private readonly proxyControlToken: string;

  constructor(
    config: ConfigService,
    private readonly resolutions: CallerResolutions
  ) {
    this.proxyControlToken = config.getOrThrow<string>('proxyControlToken');
  }

  @Post('resolve-webhook')
  async resolveWebhook(
    @Headers('x-proxy-control-token') token: string | undefined,
    @Body() body: ResolveWebhookBody | undefined,
    @Res() reply: FastifyReply
  ): Promise<void> {
    this.assertProxy(token);
    const service = typeof body?.service === 'string' ? body.service : '';
    const { status, ...answer } = await this.resolutions.resolveWebhook(service, body?.development === true);
    await reply.status(status).send(answer);
  }

  @Post('resolve')
  async resolve(
    @Headers('x-proxy-control-token') token: string | undefined,
    @Body() body: ResolveBody | undefined,
    @Res() reply: FastifyReply
  ): Promise<void> {
    this.assertProxy(token);
    const credential = typeof body?.credential === 'string' ? body.credential : undefined;
    const slug = typeof body?.slug === 'string' ? body.slug : '';
    const { status, ...answer } = await this.resolutions.resolve(credential, slug);
    await reply.status(status).send(answer);
  }

  private assertProxy(token: string | undefined): void {
    if (!token || token !== this.proxyControlToken) throw new ForbiddenException('Invalid proxy control token');
  }
}
