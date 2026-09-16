import { Module } from '@nestjs/common';
import { AgentSessionModule } from '../../agent-session/agent-session.module';
import { ProjectEnvironmentModule } from '../../project-environment/project-environment.module';
import { ProjectModule } from '../../project/project.module';
import { WorkspaceModule } from '../../workspace/workspace.module';
import { ProjectPlacementRepository } from './project-placement.repository';
import { ProjectPlacementService } from './project-placement.service';
import { ProjectsController } from './projects.controller';
import { PublicProjectsRepository } from './projects.repository';
import { PublicProjectsService } from './projects.service';

@Module({
  imports: [ProjectModule, WorkspaceModule, ProjectEnvironmentModule, AgentSessionModule],
  controllers: [ProjectsController],
  providers: [PublicProjectsRepository, ProjectPlacementRepository, PublicProjectsService, ProjectPlacementService],
  exports: [PublicProjectsService],
})
export class PublicApiProjectsModule {}
