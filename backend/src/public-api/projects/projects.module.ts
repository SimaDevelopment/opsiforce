import { Module } from '@nestjs/common';
import { AgentSessionModule } from '../../agent-session/agent-session.module';
import { BuilderModule } from '../../builder/builder.module';
import { PublicApiAuthModule } from '../auth/public-api-auth.module';
import { ProjectEnvironmentModule } from '../../project-environment/project-environment.module';
import { ProjectEventsModule } from '../../project/project-events.module';
import { ProjectModule } from '../../project/project.module';
import { WorkspaceModule } from '../../workspace/workspace.module';
import { ProjectPlacementRepository } from './project-placement.repository';
import { ProjectPlacementService } from './project-placement.service';
import { ProjectsController } from './projects.controller';
import { PublicProjectsRepository } from './projects.repository';
import { PublicProjectsService } from './projects.service';

@Module({
  imports: [
    PublicApiAuthModule,
    ProjectEventsModule,
    ProjectModule,
    WorkspaceModule,
    ProjectEnvironmentModule,
    AgentSessionModule,
    BuilderModule,
  ],
  controllers: [ProjectsController],
  providers: [PublicProjectsRepository, ProjectPlacementRepository, PublicProjectsService, ProjectPlacementService],
  exports: [PublicProjectsService],
})
export class PublicApiProjectsModule {}
