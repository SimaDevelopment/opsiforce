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
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Perms } from '../../permission/permission.constants';
import { RequireAnyPermission, RequirePermission } from '../../permission/permission.guard';
import { getGroupsHeader, hasPermission } from '../../permission/permission.utils';
import { CurrentTenant, type TenantContext } from '../../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../../user/user.decorator';
import { CallLogReader, parseCallPageQuery, type CallPage } from '../calls/call-log-reader';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import {
  ServiceViews,
  type CustomServiceView,
  type DevelopmentServiceView,
  type TenantServiceView,
  type SavedCustomServiceView,
  type UncallableCustomServiceView,
} from '../configuration/service-views';
import type { ServiceOpenApiDocument } from '../gate/service-openapi';
import { CustomServiceRepository } from '../custom/custom-service.repository';
import { customServiceSummaryOf, type CustomServiceSummary } from '../custom/custom-service-summary';
import { FormCalls, formCallRouteOf } from '../gate/form-calls';
import { sendGateAnswer } from '../gate/service-answers';
import type { ServiceLane } from '../registry/custom-service-catalog';
import { ServiceRegistry } from '../registry/service-registry';

export type TenantServiceEntry = TenantServiceView | CustomServiceSummary;

function managesCustomServices(req: FastifyRequest): boolean {
  return hasPermission(getGroupsHeader(req), Perms.manageTenantExternalServices);
}

@Controller('external-services/services')
@RequireAnyPermission([Perms.manageTenantExternalServices, Perms.managePlatformExternalServices])
@UseFilters(InvalidConfigurationFilter)
export class TenantServicesController {
  constructor(
    private readonly views: ServiceViews,
    private readonly customServices: CustomServiceRepository,
    private readonly registry: ServiceRegistry,
    private readonly calls: CallLogReader,
    private readonly formCalls: FormCalls
  ) {}

  @Get()
  async list(@CurrentTenant() tenant: TenantContext, @Req() req: FastifyRequest): Promise<TenantServiceEntry[]> {
    const builtIns = await this.views.tenantList(tenant.tenantId);
    if (!managesCustomServices(req)) return builtIns;
    const [rows, callable] = await Promise.all([
      this.customServices.listForTenant(tenant.tenantId),
      this.registry.listForTenant(tenant.tenantId),
    ]);
    const builtInSlugs = new Set(this.registry.list().map((service) => service.slug));
    return [
      ...builtIns,
      ...rows.map((row) =>
        customServiceSummaryOf(row, {
          published: callable.find((service) => service.id === row.id),
          hidesBuiltIn: builtInSlugs.has(row.slug),
        })
      ),
    ];
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: FastifyRequest
  ): Promise<TenantServiceView | CustomServiceView | UncallableCustomServiceView> {
    return this.views.tenantView(tenant.tenantId, id, managesCustomServices(req));
  }

  @Get(':id/openapi.json')
  openApi(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: FastifyRequest
  ): Promise<ServiceOpenApiDocument> {
    return this.views.tenantOpenApi(tenant.tenantId, id, managesCustomServices(req));
  }

  @Put(':id/configuration')
  @RequirePermission(Perms.manageTenantExternalServices)
  saveServiceConfiguration(
    @Param('id') id: string,
    @Body() body: { values?: unknown } | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SavedCustomServiceView> {
    return this.views.saveCustomServiceConfiguration(tenant.tenantId, id, body?.values, user.userId);
  }

  @Post(':id/configuration/rotate')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  rotateServiceConfiguration(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SavedCustomServiceView> {
    return this.views.rotateCustomServiceConfiguration(tenant.tenantId, id, body, user.userId);
  }

  @Post(':id/configuration/hook/retry')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  retryServiceConfigurationHook(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomServiceView> {
    return this.views.retryCustomServiceConfigurationHook(tenant.tenantId, id, user.userId);
  }

  @Post(':id/configuration/hook/discard')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  discardServiceConfigurationHook(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext
  ): Promise<CustomServiceView> {
    return this.views.discardCustomServiceConfigurationHook(tenant.tenantId, id);
  }

  @Get(':id/development')
  @RequirePermission(Perms.manageTenantExternalServices)
  getDevelopment(@Param('id') id: string, @CurrentTenant() tenant: TenantContext): Promise<DevelopmentServiceView> {
    return this.views.developmentView(tenant.tenantId, id);
  }

  @Put(':id/development/configuration')
  @RequirePermission(Perms.manageTenantExternalServices)
  saveDevelopmentConfiguration(
    @Param('id') id: string,
    @Body() body: { values?: unknown } | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<DevelopmentServiceView> {
    return this.views.saveDevelopmentConfiguration(tenant.tenantId, id, body?.values, user.userId);
  }

  @Post(':id/development/configuration/rotate')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  rotateDevelopmentConfiguration(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<DevelopmentServiceView> {
    return this.views.rotateDevelopmentConfiguration(tenant.tenantId, id, body, user.userId);
  }

  @Post(':id/development/configuration/hook/retry')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  retryDevelopmentConfigurationHook(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<DevelopmentServiceView> {
    return this.views.retryDevelopmentConfigurationHook(tenant.tenantId, id, user.userId);
  }

  @Post(':id/development/configuration/hook/discard')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  discardDevelopmentConfigurationHook(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext
  ): Promise<DevelopmentServiceView> {
    return this.views.discardDevelopmentConfigurationHook(tenant.tenantId, id);
  }

  @Post(':id/development/configuration/copy-from-production')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  copyProductionToDevelopment(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<DevelopmentServiceView> {
    return this.views.copyProductionToDevelopment(tenant.tenantId, id, user.userId);
  }

  @Post(':id/development/:route/:name')
  @RequirePermission(Perms.manageTenantExternalServices)
  async callDevelopmentServiceForm(
    @Param('id') id: string,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.sendServiceFormCall(reply, { id, route, name, body, tenant, user, lane: 'development' });
  }

  @Post(':id/:route/:name')
  @RequirePermission(Perms.manageTenantExternalServices)
  async callServiceForm(
    @Param('id') id: string,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.sendServiceFormCall(reply, { id, route, name, body, tenant, user, lane: 'default' });
  }

  private async sendServiceFormCall(
    reply: FastifyReply,
    call: {
      id: string;
      route: string;
      name: string;
      body: unknown;
      tenant: TenantContext;
      user: UserContext;
      lane: ServiceLane;
    }
  ): Promise<void> {
    const formCallRoute = formCallRouteOf(call.route);
    if (!formCallRoute) throw new NotFoundException(`No form call route ${call.route}`);
    await sendGateAnswer(
      reply,
      await this.formCalls.callServiceForm({
        serviceId: call.id,
        tenantId: call.tenant.tenantId,
        keycloakId: call.user.userId,
        route: formCallRoute,
        name: call.name,
        body: call.body,
        lane: call.lane,
      })
    );
  }

  @Get(':id/calls')
  @RequirePermission(Perms.manageTenantExternalServices)
  async listCalls(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext
  ): Promise<CallPage> {
    const page = parseCallPageQuery(query);
    const service = await this.calls.serviceOwnership(id);
    if (service.tenantId !== tenant.tenantId) throw new NotFoundException(`No External Service ${id}`);
    return this.calls.page({ serviceId: id, tenantId: tenant.tenantId }, page);
  }
}
