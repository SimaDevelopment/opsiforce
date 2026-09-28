import { Global, Module } from '@nestjs/common';
import { AgentTemplateStore } from '../agent-template/agent-template.store';
import { ProjectModule } from '../project/project.module';
import { AgentBundleReader } from './agent-bundle.reader';
import { AgentBundleWriter } from './agent-bundle.writer';
import { AgentController } from './agent.controller';
import { AgentExportService } from './agent-export.service';
import { AgentImportService } from './agent-import.service';
import { AgentProfileService } from './agent-profile.service';
import { AgentReconcilerService } from './agent-reconciler.service';
import { AgentRepository } from './agent.repository';
import { AgentService } from './agent.service';

@Global()
@Module({
  imports: [ProjectModule],
  controllers: [AgentController],
  providers: [
    AgentRepository,
    AgentProfileService,
    AgentService,
    AgentReconcilerService,
    AgentTemplateStore,
    AgentBundleReader,
    AgentBundleWriter,
    AgentExportService,
    AgentImportService,
  ],
  exports: [
    AgentRepository,
    AgentService,
    AgentReconcilerService,
    AgentTemplateStore,
    AgentBundleReader,
    AgentBundleWriter,
  ],
})
export class AgentModule {}
