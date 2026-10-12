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
import { CurrentTenant, type TenantContext } from '../../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../../user/user.decorator';
import { CallLogReader, parseCallPageQuery, type CallPage } from '../calls/call-log-reader';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import { FormCalls, formCallRouteOf } from '../gate/form-calls';
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
    private readonly calls: CallLogReader
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

  @Get(':serviceId/calls')
  async listCalls(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('serviceId') serviceId: string,
    @Query() query: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CallPage> {
    const page = parseCallPageQuery(query);
    await this.views.assertCanOpen(this.viewer(tenant, user, projectId, projectEnvironmentId));
    const service = await this.calls.serviceOwnership(serviceId);
    if (service.tenantId !== null && service.tenantId !== tenant.tenantId) {
      throw new NotFoundException(`No External Service ${serviceId}`);
    }
    return this.calls.page({ projectEnvironmentId, serviceId }, page);
  }

  @Put(':serviceId/configuration')
  @RequirePermission(Perms.configureProjectExternalServices)
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

  @Post(':serviceId/configuration/rotate')
  @HttpCode(200)
  @RequirePermission(Perms.configureProjectExternalServices)
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
  @RequirePermission(Perms.configureProjectExternalServices)
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
  @RequirePermission(Perms.configureProjectExternalServices)
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
  @RequirePermission(Perms.configureProjectExternalServices)
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
