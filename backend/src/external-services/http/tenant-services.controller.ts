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
import { parseCallLogQuery, ServiceCallLog, type CallLogPage } from '../calls/service-call-log';
import { parseServiceCopy } from '../calls/service-records-file';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import {
  ServiceViews,
  type CustomServiceView,
  type DevelopmentServiceView,
  type TenantServiceView,
  type SavedCustomServiceView,
  type UncallableCustomServiceView,
} from '../configuration/service-views';
import { CustomServiceRepository } from '../custom/custom-service.repository';
import { customServiceSummaryOf, type CustomServiceSummary } from '../custom/custom-service-summary';
import { FormCalls, formCallRouteOf } from '../gate/form-calls';
import { sendGateAnswer } from '../gate/service-answers';
import type { ServiceLane } from '../registry/custom-service-catalog';
import { ServiceRegistry } from '../registry/service-registry';
import { parseUsageMonth, ServiceUsage, type ServiceUsageView } from '../usage/service-usage';

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
    private readonly callLog: ServiceCallLog,
    private readonly usage: ServiceUsage,
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
    const publishedIn = await this.customServices.publishedEnvironmentIds(rows.map((row) => row.builderChatId));
    const builtInSlugs = new Set(this.registry.list().map((service) => service.slug));
    return [
      ...builtIns,
      ...rows.map((row) =>
        customServiceSummaryOf(row, {
          published: callable.find((service) => service.id === row.id),
          publishedEnvironmentIds: publishedIn.get(row.builderChatId) ?? [],
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

  @Put(':id/configuration')
  @RequirePermission(Perms.manageTenantExternalServices)
  saveServiceConfiguration(
    @Param('id') id: string,
    @Body() body: { values?: unknown } | undefined,
    @CurrentTenant() tenant: TenantContext
  ): Promise<SavedCustomServiceView> {
    return this.views.saveCustomServiceConfiguration(tenant.tenantId, id, body?.values);
  }

  @Post(':id/configuration/rotate')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  rotateServiceConfiguration(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext
  ): Promise<SavedCustomServiceView> {
    return this.views.rotateCustomServiceConfiguration(tenant.tenantId, id, body);
  }

  @Post(':id/configuration/hook/retry')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  retryServiceConfigurationHook(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext
  ): Promise<CustomServiceView> {
    return this.views.retryCustomServiceConfigurationHook(tenant.tenantId, id);
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
    @CurrentTenant() tenant: TenantContext
  ): Promise<DevelopmentServiceView> {
    return this.views.saveDevelopmentConfiguration(tenant.tenantId, id, body?.values);
  }

  @Post(':id/development/configuration/rotate')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  rotateDevelopmentConfiguration(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext
  ): Promise<DevelopmentServiceView> {
    return this.views.rotateDevelopmentConfiguration(tenant.tenantId, id, body);
  }

  @Post(':id/development/configuration/hook/retry')
  @HttpCode(200)
  @RequirePermission(Perms.manageTenantExternalServices)
  retryDevelopmentConfigurationHook(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext
  ): Promise<DevelopmentServiceView> {
    return this.views.retryDevelopmentConfigurationHook(tenant.tenantId, id);
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
    @CurrentTenant() tenant: TenantContext
  ): Promise<DevelopmentServiceView> {
    return this.views.copyProductionToDevelopment(tenant.tenantId, id);
  }

  @Post(':id/development/:route/:name')
  @RequirePermission(Perms.manageTenantExternalServices)
  async callDevelopmentServiceForm(
    @Param('id') id: string,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.sendServiceFormCall(reply, { id, route, name, body, tenant, lane: 'development' });
  }

  @Post(':id/:route/:name')
  @RequirePermission(Perms.manageTenantExternalServices)
  async callServiceForm(
    @Param('id') id: string,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.sendServiceFormCall(reply, { id, route, name, body, tenant, lane: 'default' });
  }

  private async sendServiceFormCall(
    reply: FastifyReply,
    call: {
      id: string;
      route: string;
      name: string;
      body: unknown;
      tenant: TenantContext;
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
        route: formCallRoute,
        name: call.name,
        body: call.body,
        lane: call.lane,
      })
    );
  }

  @Get(':id/call-log')
  @RequirePermission(Perms.manageTenantExternalServices)
  readCallLog(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext
  ): Promise<CallLogPage> {
    const page = parseCallLogQuery(query);
    const copy = parseServiceCopy(query.copy);
    return this.callLog.page({ tenantId: tenant.tenantId, serviceId: id, copy }, page);
  }

  @Get(':id/usage')
  @RequirePermission(Perms.manageTenantExternalServices)
  readUsage(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext
  ): Promise<ServiceUsageView> {
    return this.usage.view(tenant.tenantId, id, parseServiceCopy(query.copy), parseUsageMonth(query.month));
  }
}
