import { Controller, Post, Body, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { Public } from '../tenant/tenant.decorator';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { GatewayService } from './gateway.service';
import type { GatewayRequest } from './gateway-key.service';

interface GatewayRequestBody {
  service: string;
  payload: unknown;
}

@Public()
@UseGuards(GatewayAuthGuard)
@Controller('gateway')
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  @Post()
  async handle(@Body() body: GatewayRequestBody, @Req() req: GatewayRequest) {
    if (!body?.service) {
      throw new BadRequestException("Missing 'service' field");
    }

    if (body.service === 'email') {
      throw new BadRequestException('Email sending is not supported on this platform.');
    }

    const context = req.gatewayContext;
    if (!context.tenantId) {
      throw new BadRequestException('Gateway calls require a claimed project');
    }

    const result = await this.gatewayService.dispatch(body.service, body.payload, {
      projectId: context.projectId,
      tenantId: context.tenantId,
    });

    if (result.success) {
      return { success: true, data: result.data };
    }

    return { success: false, error: result.error };
  }
}
