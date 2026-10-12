import { Controller, Head, Param, Post, Req, Res } from '@nestjs/common';
import type { ProblemDetails } from '@opsiforce/external-service-sdk';
import type { FastifyReply } from 'fastify';
import { Public } from '../../tenant/tenant.decorator';
import { DEVELOPMENT_WEBHOOK_SUFFIX, WEBHOOKS_MOUNT } from '../configuration/webhook-url';
import { unknownServiceProblem, unservableServiceProblem } from '../gate/gate-refusals';
import { sendGateAnswer } from '../gate/service-answers';
import { InboundPipeline, type InboundOutcome } from '../inbound/inbound-pipeline';
import type { InboundRequest } from '../inbound/inbound-request';
import { UnservableCustomService } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { sendProblem } from './problem-reply';
import { inboundRequestOf, type WebhookFastifyRequest } from './webhook-request';

type Reception = { problem: ProblemDetails } | { outcome: InboundOutcome };

@Public()
@Controller(WEBHOOKS_MOUNT)
export class WebhooksController {
  constructor(
    private readonly services: ServiceRegistry,
    private readonly inbound: InboundPipeline
  ) {}

  @Head(':service')
  async acknowledgeReachability(@Param('service') slugOrId: string, @Res() reply: FastifyReply): Promise<void> {
    await this.acknowledge(reply, () => this.services.webhookTarget(slugOrId));
  }

  @Head(`:service/${DEVELOPMENT_WEBHOOK_SUFFIX}`)
  async acknowledgeDevelopmentReachability(@Param('service') id: string, @Res() reply: FastifyReply): Promise<void> {
    await this.acknowledge(reply, () => this.services.development(id));
  }

  @Post(':service')
  async receive(
    @Param('service') slugOrId: string,
    @Req() req: WebhookFastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.receiveFor(slugOrId, req, reply, async () => this.services.webhookTarget(slugOrId));
  }

  @Post(`:service/${DEVELOPMENT_WEBHOOK_SUFFIX}`)
  async receiveForDevelopment(
    @Param('service') id: string,
    @Req() req: WebhookFastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.receiveFor(id, req, reply, () => this.services.development(id));
  }

  private async receiveFor(
    name: string,
    req: WebhookFastifyRequest,
    reply: FastifyReply,
    resolve: () => Promise<RegisteredService | null | undefined>
  ): Promise<void> {
    const request = await inboundRequestOf(req);
    let reception = await this.reception(name, request, resolve);
    if ('outcome' in reception && reception.outcome.moved) reception = await this.reception(name, request, resolve);
    if ('problem' in reception) await sendProblem(reply, reception.problem);
    else await sendGateAnswer(reply, reception.outcome.answer);
  }

  private async acknowledge(
    reply: FastifyReply,
    resolve: () => Promise<RegisteredService | null | undefined>
  ): Promise<void> {
    let known = true;
    try {
      known = Boolean(await resolve());
    } catch (error) {
      if (!(error instanceof UnservableCustomService)) throw error;
    }
    await reply.code(known ? 200 : 404).send();
  }

  private async reception(
    name: string,
    request: InboundRequest,
    resolve: () => Promise<RegisteredService | null | undefined>
  ): Promise<Reception> {
    let service: RegisteredService | null | undefined;
    try {
      service = await resolve();
    } catch (error) {
      if (!(error instanceof UnservableCustomService)) throw error;
      return { problem: unservableServiceProblem(error) };
    }
    if (!service) return { problem: unknownServiceProblem(name) };
    return { outcome: await this.inbound.receive(service, request) };
  }
}
