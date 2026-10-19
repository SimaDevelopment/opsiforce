import { Controller, Headers, Post, Req, Res } from '@nestjs/common';
import { callerIdentityHeader } from '@opsiforce/external-service-sdk/server';
import type { FastifyReply } from 'fastify';
import { Public } from '../../tenant/tenant.decorator';
import { ConfigurationFetch, ConfigurationFetchRefused } from '../configuration/configuration-fetch';
import { bearerTokenOf } from '../gate/gate-routes';
import { EventDeliveries, EventDeliveryFailed } from '../inbound/event-deliveries';
import { readEventEnvelope } from '../inbound/event-envelope';
import { parseMultipartUpload, type MultipartFastifyRequest } from './multipart-upload';

@Public()
@Controller('gateway/events')
export class EventDeliveriesController {
  constructor(
    private readonly fetch: ConfigurationFetch,
    private readonly deliveries: EventDeliveries
  ) {}

  @Post()
  async deliver(
    @Headers('authorization') authorization: string | undefined,
    @Headers(callerIdentityHeader) callerIdentity: string | undefined,
    @Req() req: MultipartFastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    try {
      const podKey = bearerTokenOf(authorization);
      const copy = await this.fetch.copyOf(podKey);
      this.fetch.callerOf(callerIdentity, podKey ?? '');
      if (!req.isMultipart()) {
        await reply.status(400).send({ problems: ['send the Event as multipart/form-data'] });
        return;
      }
      const { fields, files } = await parseMultipartUpload(req);
      const reading = readEventEnvelope(
        copy.manifest,
        fields,
        files.map((file) => ({
          field: file.fieldName,
          filename: file.filename,
          mimeType: file.contentType,
          bytes: new Uint8Array(file.bytes),
        }))
      );
      if ('problems' in reading) {
        await reply.status(400).send({ problems: reading.problems });
        return;
      }
      await reply
        .header('cache-control', 'no-store')
        .send({ results: await this.deliveries.deliver(copy, reading.envelope) });
    } catch (error) {
      if (error instanceof ConfigurationFetchRefused || error instanceof EventDeliveryFailed) {
        await reply.status(error.status).send({ message: error.message });
        return;
      }
      throw error;
    }
  }
}
