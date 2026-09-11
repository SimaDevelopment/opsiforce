import { Global, Module, forwardRef } from '@nestjs/common';
import { AgentSessionModule } from '../agent-session/agent-session.module';
import { PodModule } from '../pod/pod.module';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { AgentStatusService } from './agent-status.service';
import { ProjectEventsModule } from './project-events.module';

@Global()
@Module({
  imports: [ProjectEventsModule, ProjectEnvironmentModule, PodModule, forwardRef(() => AgentSessionModule)],
  providers: [AgentStatusService],
  exports: [AgentStatusService],
})
export class AgentStatusModule {}
