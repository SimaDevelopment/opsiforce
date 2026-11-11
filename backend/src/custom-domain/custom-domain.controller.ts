import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequirePermission } from '../permission/permission.guard';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { isProjectAccessible } from '../project/project-visibility';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { CustomDomainService } from './custom-domain.service';
import type {
  AddCustomDomainDto,
  CustomDomainView,
  CustomDomainsView,
  UpdateCustomDomainDto,
} from './custom-domain.types';
import { customDomainsOffered } from './custom-domains-offered';

@Controller('projects/:projectId/environments/:environmentId/domains')
export class CustomDomainController {
  constructor(
    private readonly customDomains: CustomDomainService,
    private readonly environments: ProjectEnvironmentService,
    private readonly users: UserService,
    private readonly config: ConfigService
  ) {}

  @Get()
  async list(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomDomainsView> {
    const env = await this.reachableEnvironment(projectId, environmentId, tenant, user);
    return this.customDomains.list(env, tenant.tenantId);
  }

  @Post()
  @RequirePermission('can_manage_custom_domains')
  async add(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Body() dto: AddCustomDomainDto | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomDomainView> {
    const env = await this.reachableEnvironment(projectId, environmentId, tenant, user);
    return this.customDomains.add(env, tenant.tenantId, dto);
  }

  @Post('refresh')
  @RequirePermission('can_manage_custom_domains')
  async refresh(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomDomainsView> {
    const env = await this.reachableEnvironment(projectId, environmentId, tenant, user);
    return this.customDomains.refresh(env, tenant.tenantId);
  }

  @Post(':domainId/check')
  @RequirePermission('can_manage_custom_domains')
  async check(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Param('domainId') domainId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomDomainView> {
    const env = await this.reachableEnvironment(projectId, environmentId, tenant, user);
    return this.customDomains.check(env, domainId);
  }

  @Post(':domainId/main')
  @RequirePermission('can_manage_custom_domains')
  async makeMain(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Param('domainId') domainId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomDomainView> {
    const env = await this.reachableEnvironment(projectId, environmentId, tenant, user);
    return this.customDomains.makeMain(env, domainId);
  }

  @Patch(':domainId')
  @RequirePermission('can_manage_custom_domains')
  async update(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Param('domainId') domainId: string,
    @Body() dto: UpdateCustomDomainDto | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<CustomDomainView> {
    const env = await this.reachableEnvironment(projectId, environmentId, tenant, user);
    return this.customDomains.setRedirectToMain(env, domainId, dto);
  }

  @Delete(':domainId')
  @RequirePermission('can_manage_custom_domains')
  async remove(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Param('domainId') domainId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<{ ok: true }> {
    const env = await this.reachableEnvironment(projectId, environmentId, tenant, user);
    await this.customDomains.remove(env, domainId);
    return { ok: true };
  }

  private async reachableEnvironment(
    projectId: string,
    environmentId: string,
    tenant: TenantContext,
    user: UserContext
  ): Promise<ProjectEnvironmentContext> {
    if (!customDomainsOffered(this.config)) throw new NotFoundException('This deployment offers no custom domains');
    const userId = await this.users.resolveUserId(user, tenant.tenantId);
    const env = await this.environments.findByIdOrNull(environmentId);
    if (
      !env ||
      env.projectId !== projectId ||
      env.servesAnExternalService ||
      !(await isProjectAccessible(tenant.tenantId, userId, projectId))
    ) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return env;
  }
}
