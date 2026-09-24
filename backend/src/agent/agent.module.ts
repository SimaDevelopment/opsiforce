import { Global, Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module';
import { AgentController } from './agent.controller';
import { AgentProfileService } from './agent-profile.service';
import { AgentReconcilerService } from './agent-reconciler.service';
import { AgentRepository } from './agent.repository';
import { AgentService } from './agent.service';

@Global()
@Module({
  imports: [ProjectModule],
  controllers: [AgentController],
  providers: [AgentRepository, AgentProfileService, AgentService, AgentReconcilerService],
  exports: [AgentRepository, AgentService, AgentReconcilerService],
})
export class AgentModule {}
