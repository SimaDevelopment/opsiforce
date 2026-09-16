import { Module } from '@nestjs/common';
import { ProxyService } from './proxy.service';
import { ProxyController } from './proxy.controller';
import { ProjectModule } from '../project/project.module';
import { TenantModule } from '../tenant/tenant.module';
import { AgentSessionModule } from '../agent-session/agent-session.module';
import { PodModule } from '../pod/pod.module';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';

@Module({
  imports: [ProjectModule, TenantModule, AgentSessionModule, PodModule, ProjectEnvironmentModule],
  providers: [ProxyService],
  controllers: [ProxyController],
  exports: [ProxyService],
})
export class ProxyModule {}
