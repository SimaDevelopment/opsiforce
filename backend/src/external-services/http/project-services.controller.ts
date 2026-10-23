import {
  Body,
  Controller,
  Delete,
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
import { RequireAnyPermission, RequirePermission } from '../../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../../user/user.decorator';
import { parseCallLogQuery, ServiceCallLog, type CallLogPage } from '../calls/service-call-log';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import { FormCalls, formCallRouteOf } from '../gate/form-calls';
import { EventDeliveryStatus, type EventDeliveryStatusView } from '../inbound/event-delivery-status';
import { sendGateAnswer } from '../gate/service-answers';
import {
  ProjectServiceViews,
  type ProjectEnvironmentViewer,
  type ProjectServiceList,
  type ProjectServiceView,
  type SavedProjectServiceView,
} from '../configuration/project-service-views';

@Controller('external-services/projects/:projectId/environments/:projectEnvironmentId/services')
@UseFilters(InvalidConfigurationFilter)
export class ProjectServicesController {
  constructor(
    private readonly views: ProjectServiceViews,
    private readonly formCalls: FormCalls,
    private readonly callLog: ServiceCallLog,
    private readonly eventDeliveries: EventDeliveryStatus
  ) {}

  @Get()
  list(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectServiceList> {
    return this.views.list(this.viewer(tenant, user, projectId, projectEnvironmentId));
  }

  @Get(':serviceId')
  get(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectServiceView> {
    return this.views.view(this.viewer(tenant, user, projectId, projectEnvironmentId), serviceId);
  }

  @Get(':serviceId/call-log')
  async readCallLog(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @Query() query: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CallLogPage> {
    const { projectId: _project, ...page } = parseCallLogQuery(query);
    await this.views.assertCanOpen(this.viewer(tenant, user, projectId, projectEnvironmentId));
    return this.callLog.page({ tenantId: tenant.tenantId, serviceId, projectEnvironmentId }, page);
  }

  @Get(':serviceId/event-delivery')
  async readEventDelivery(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<EventDeliveryStatusView> {
    await this.views.assertCanOpen(this.viewer(tenant, user, projectId, projectEnvironmentId));
    return this.eventDeliveries.of(tenant.tenantId, projectEnvironmentId, serviceId);
  }

  @Put(':serviceId/configuration')
  @RequirePermission('can_configure_project_external_services')
  saveProjectConfiguration(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @Body() body: { values?: unknown } | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SavedProjectServiceView> {
    const viewer = this.viewer(tenant, user, projectId, projectEnvironmentId);
    return this.views.save(viewer, serviceId, body?.values);
  }

  @Delete(':serviceId/configuration')
  @RequireAnyPermission(['can_configure_project_external_services', 'can_manage_tenant_external_services'])
  disconnect(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectServiceView> {
    return this.views.disconnect(this.viewer(tenant, user, projectId, projectEnvironmentId), serviceId);
  }

  @Post(':serviceId/configuration/rotate')
  @HttpCode(200)
  @RequirePermission('can_configure_project_external_services')
  rotateProjectConfiguration(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SavedProjectServiceView> {
    return this.views.rotate(this.viewer(tenant, user, projectId, projectEnvironmentId), serviceId, body);
  }

  @Post(':serviceId/configuration/hook/retry')
  @HttpCode(200)
  @RequirePermission('can_configure_project_external_services')
  retryProjectConfigurationHook(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectServiceView> {
    return this.views.retryHook(this.viewer(tenant, user, projectId, projectEnvironmentId), serviceId);
  }

  @Post(':serviceId/configuration/hook/discard')
  @HttpCode(200)
  @RequirePermission('can_configure_project_external_services')
  discardProjectConfigurationHook(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ProjectServiceView> {
    return this.views.discardHook(this.viewer(tenant, user, projectId, projectEnvironmentId), serviceId);
  }

  @Post(':serviceId/:route/:name')
  @RequirePermission('can_configure_project_external_services')
  async callForm(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @Param('route') route: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const formCallRoute = formCallRouteOf(route);
    if (!formCallRoute) throw new NotFoundException(`No form call route ${route}`);
    const target = await this.views.formCallTarget(
      this.viewer(tenant, user, projectId, projectEnvironmentId),
      serviceId
    );
    await sendGateAnswer(reply, await this.formCalls.callProjectForm({ target, route: formCallRoute, name, body }));
  }

  private viewer(
    tenant: TenantContext,
    user: UserContext,
    projectId: string,
    projectEnvironmentId: string
  ): ProjectEnvironmentViewer {
    return { tenantId: tenant.tenantId, keycloakId: user.userId, projectId, projectEnvironmentId };
  }
}
