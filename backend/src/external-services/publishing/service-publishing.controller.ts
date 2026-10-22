import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseFilters } from '@nestjs/common';
import { Perms } from '../../permission/permission.constants';
import { RequirePermission } from '../../permission/permission.guard';
import type { PublishJobResponse } from '../../publish/publish.types';
import { CurrentTenant, type TenantContext } from '../../tenant/tenant.decorator';
import { InvalidConfigurationFilter } from '../configuration/invalid-configuration.error';
import { CustomServiceRefusalFilter } from '../custom/custom-service-refusal';
import { ServiceEnvironmentManifests, type EnvironmentManifestView } from './service-environment-manifests';
import {
  ServicePublishing,
  type DefaultEnvironmentReview,
  type NamedEnvironment,
  type PublishReview,
  type ServiceEnvironmentView,
  type ServiceSubmission,
} from './service-publishing';

@Controller('external-services/services')
@RequirePermission(Perms.manageTenantExternalServices)
@UseFilters(CustomServiceRefusalFilter, InvalidConfigurationFilter)
export class ServicePublishingController {
  constructor(
    private readonly publishing: ServicePublishing,
    private readonly manifests: ServiceEnvironmentManifests
  ) {}

  @Get(':id/environments')
  environments(@Param('id') id: string, @CurrentTenant() tenant: TenantContext): Promise<ServiceEnvironmentView[]> {
    return this.publishing.environmentsOf(tenant.tenantId, id);
  }

  @Get(':id/manifests')
  environmentManifests(
    @Param('id') id: string,
    @CurrentTenant() tenant: TenantContext
  ): Promise<EnvironmentManifestView[]> {
    return this.manifests.of(tenant.tenantId, id);
  }

  @Get(':id/publish')
  publishReview(
    @Param('id') id: string,
    @Query('environmentId') environmentId: unknown,
    @CurrentTenant() tenant: TenantContext
  ): Promise<PublishReview> {
    return this.publishing.publishReview(tenant.tenantId, id, environmentId);
  }

  @Post(':id/publish')
  @HttpCode(202)
  publish(
    @Param('id') id: string,
    @Body() body: ServiceSubmission | undefined,
    @CurrentTenant() tenant: TenantContext
  ): Promise<PublishJobResponse> {
    return this.publishing.publish(tenant.tenantId, id, body);
  }

  @Get(':id/publish/job')
  publishJob(
    @Param('id') id: string,
    @Query('environmentId') environmentId: unknown,
    @CurrentTenant() tenant: TenantContext
  ): Promise<PublishJobResponse | null> {
    return this.publishing.publishJob(tenant.tenantId, id, environmentId);
  }

  @Get(':id/default-environment')
  defaultEnvironmentReview(
    @Param('id') id: string,
    @Query('environmentId') environmentId: unknown,
    @CurrentTenant() tenant: TenantContext
  ): Promise<DefaultEnvironmentReview> {
    return this.publishing.defaultEnvironmentReview(tenant.tenantId, id, environmentId);
  }

  @Put(':id/default-environment')
  switchDefaultEnvironment(
    @Param('id') id: string,
    @Body() body: ServiceSubmission | undefined,
    @CurrentTenant() tenant: TenantContext
  ): Promise<NamedEnvironment> {
    return this.publishing.switchDefaultEnvironment(tenant.tenantId, id, body);
  }
}
