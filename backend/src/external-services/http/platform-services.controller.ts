import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../../permission/permission.guard';
import { PlatformScope } from '../../tenant/tenant.decorator';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import { FormCalls, formCallRouteOf } from '../gate/form-calls';
import { sendGateAnswer } from '../gate/service-answers';
import {
  ServiceViews,
  type OperatorServiceSummary,
  type OperatorServiceView,
  type SavedOperatorServiceView,
} from '../configuration/service-views';

@Controller('external-services/platform/services')
@PlatformScope()
@RequirePermission('can_manage_platform_external_services')
@UseFilters(InvalidConfigurationFilter)
export class PlatformServicesController {
  constructor(
    private readonly views: ServiceViews,
    private readonly formCalls: FormCalls
  ) {}

  @Get()
  list(): Promise<OperatorServiceSummary[]> {
    return this.views.operatorList();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<OperatorServiceView> {
    return this.views.operatorView(id);
  }

  @Put(':id/configuration')
  saveServiceConfiguration(
    @Param('id') id: string,
    @Body() body: { values?: unknown } | undefined
  ): Promise<SavedOperatorServiceView> {
    return this.views.saveServiceConfiguration(id, body?.values);
  }

  @Post(':id/configuration/rotate')
  @HttpCode(200)
  rotateServiceConfiguration(@Param('id') id: string, @Body() body: unknown): Promise<SavedOperatorServiceView> {
    return this.views.rotateServiceConfiguration(id, body);
  }

  @Post(':id/configuration/hook/retry')
  @HttpCode(200)
  retryServiceConfigurationHook(@Param('id') id: string): Promise<OperatorServiceView> {
    return this.views.retryServiceConfigurationHook(id);
  }

  @Post(':id/configuration/hook/discard')
  @HttpCode(200)
  discardServiceConfigurationHook(@Param('id') id: string): Promise<OperatorServiceView> {
    return this.views.discardServiceConfigurationHook(id);
  }

  @Post(':id/:route/:name')
  async callForm(
    @Param('id') id: string,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const formCallRoute = formCallRouteOf(route);
    if (!formCallRoute) throw new NotFoundException(`No form call route ${route}`);
    await sendGateAnswer(
      reply,
      await this.formCalls.callServiceForm({ serviceId: id, route: formCallRoute, name, body })
    );
  }
}
