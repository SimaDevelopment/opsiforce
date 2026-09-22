import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { AgentUpdateK8sService } from './agent-update.k8s.service';
import { AgentUpdateProcessor } from './agent-update.processor';
import { AgentUpdateService } from './agent-update.service';
import { AGENT_WORKSPACE_UPDATE_QUEUE } from './agent-update.types';
import { AgentSessionModule } from '../agent-session/agent-session.module';
import { ProjectModule } from '../project/project.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: AGENT_WORKSPACE_UPDATE_QUEUE }),
    BullBoardModule.forFeature({ name: AGENT_WORKSPACE_UPDATE_QUEUE, adapter: BullMQAdapter }),
    ProjectModule,
    forwardRef(() => AgentSessionModule),
  ],
  providers: [AgentUpdateService, AgentUpdateProcessor, AgentUpdateK8sService],
  exports: [AgentUpdateService],
})
export class AgentUpdateModule {}
