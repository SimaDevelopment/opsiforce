import { Controller, Get } from '@nestjs/common';
import { ProjectService } from './project.service';
import { RequirePermission } from '../permission/permission.guard';

@Controller('pod-classes')
export class PodClassController {
  constructor(private readonly projectService: ProjectService) {}

  @Get()
  @RequirePermission('can_manage_project_pod_settings')
  getCatalog() {
    return this.projectService.getPodClassCatalog();
  }
}
