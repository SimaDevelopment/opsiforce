import { Global, Module, forwardRef } from '@nestjs/common';
import { AgentSessionModule } from '../agent-session/agent-session.module';
import { PodModule } from '../pod/pod.module';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { TimeoutModule } from '../timeout/timeout.module';
import { AGENT_STATUS_TIMER, AgentStatusService, unrefTimer } from './agent-status.service';
import { ProjectEventsModule } from './project-events.module';

@Global()
@Module({
  imports: [
    ProjectEventsModule,
    ProjectEnvironmentModule,
    PodModule,
    forwardRef(() => AgentSessionModule),
    TimeoutModule,
  ],
  providers: [AgentStatusService, { provide: AGENT_STATUS_TIMER, useValue: unrefTimer }],
  exports: [AgentStatusService],
})
export class AgentStatusModule {}
