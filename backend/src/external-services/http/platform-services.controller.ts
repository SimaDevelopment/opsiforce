import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Perms } from '../../permission/permission.constants';
import { RequirePermission } from '../../permission/permission.guard';
import { PlatformScope } from '../../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../../user/user.decorator';
import { CallLogReader, parseCallPageQuery, type CallPage } from '../calls/call-log-reader';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import { FormCalls, formCallRouteOf } from '../gate/form-calls';
import { sendGateAnswer } from '../gate/service-answers';
import {
  ServiceViews,
  type OperatorServiceSummary,
  type OperatorServiceView,
  type SavedOperatorServiceView,
} from '../configuration/service-views';
import type { ServiceOpenApiDocument } from '../gate/service-openapi';

@Controller('external-services/platform/services')
@PlatformScope()
@RequirePermission(Perms.managePlatformExternalServices)
@UseFilters(InvalidConfigurationFilter)
export class PlatformServicesController {
  constructor(
    private readonly views: ServiceViews,
    private readonly formCalls: FormCalls,
    private readonly calls: CallLogReader
  ) {}

  @Get()
  list(): Promise<OperatorServiceSummary[]> {
    return this.views.operatorList();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<OperatorServiceView> {
    return this.views.operatorView(id);
  }

  @Get(':id/openapi.json')
  openApi(@Param('id') id: string): ServiceOpenApiDocument {
    return this.views.operatorOpenApi(id);
  }

  @Get(':id/calls')
  async listCalls(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<CallPage> {
    const page = parseCallPageQuery(query);
    const service = await this.calls.serviceOwnership(id);
    if (service.tenantId !== null) throw new NotFoundException(`No built-in External Service ${id}`);
    return this.calls.page({ serviceId: id }, page);
  }

  @Put(':id/configuration')
  saveServiceConfiguration(
    @Param('id') id: string,
    @Body() body: { values?: unknown } | undefined,
    @CurrentUser() user: UserContext
  ): Promise<SavedOperatorServiceView> {
    return this.views.saveServiceConfiguration(id, body?.values, user.userId);
  }

  @Post(':id/configuration/rotate')
  @HttpCode(200)
  rotateServiceConfiguration(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: UserContext
  ): Promise<SavedOperatorServiceView> {
    return this.views.rotateServiceConfiguration(id, body, user.userId);
  }

  @Post(':id/configuration/hook/retry')
  @HttpCode(200)
  retryServiceConfigurationHook(
    @Param('id') id: string,
    @CurrentUser() user: UserContext
  ): Promise<OperatorServiceView> {
    return this.views.retryServiceConfigurationHook(id, user.userId);
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
    @CurrentUser() user: UserContext,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const formCallRoute = formCallRouteOf(route);
    if (!formCallRoute) throw new NotFoundException(`No form call route ${route}`);
    await sendGateAnswer(
      reply,
      await this.formCalls.callServiceForm({ serviceId: id, keycloakId: user.userId, route: formCallRoute, name, body })
    );
  }
}
