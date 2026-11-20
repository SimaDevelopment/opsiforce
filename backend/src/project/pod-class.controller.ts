import { Controller, Get } from '@nestjs/common';
import { ProjectService } from './project.service';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';

@Controller('pod-classes')
export class PodClassController {
  constructor(private readonly projectService: ProjectService) {}

  @Get()
  @RequirePermission('can_manage_project_pod_settings')
  getCatalog(@CurrentTenant() tenant: TenantContext) {
    return this.projectService.getPodClassCatalog(tenant.tenantId);
  }
}
