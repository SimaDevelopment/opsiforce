import { Module, forwardRef } from '@nestjs/common';
import { AgentUpdateModule } from '../agent-update/agent-update.module';
import { PodModule } from '../pod/pod.module';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { ProjectModule } from '../project/project.module';
import { AgentConnectionService } from './agent-connection.service';
import { AgentSessionGateway } from './agent-session.gateway';
import { PodOpencodeClient } from './pod-opencode.client';

@Module({
  imports: [PodModule, ProjectEnvironmentModule, forwardRef(() => ProjectModule), forwardRef(() => AgentUpdateModule)],
  providers: [AgentConnectionService, AgentSessionGateway, PodOpencodeClient],
  exports: [AgentConnectionService, AgentSessionGateway],
})
export class AgentSessionModule {}
