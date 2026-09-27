import { Module, forwardRef, type OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Queue } from 'bullmq';
import { ProjectController } from './project.controller';
import { AppAgentController } from './app.controller.agent';
import { AgentStatusController } from './agent-status.controller';
import { AgentStatusStreamController } from './agent-status-stream.controller';
import { PodClassController } from './pod-class.controller';
import { ProjectService } from './project.service';
import { ProjectAuthService } from './project-auth.service';
import { ProjectFilesService } from './project-files.service';
import { ProjectDuplicateProcessor } from './project-duplicate.processor';
import { ProjectImportController } from './project-import.controller';
import { ProjectImportUploadController } from './project-import-upload.controller';
import { ProjectImportService } from './project-import.service';
import { ProjectImportUploadService } from './project-import-upload.service';
import { ProjectImportProcessor } from './project-import.processor';
import {
  ProjectImportUploadCleanupProcessor,
  PROJECT_IMPORT_UPLOAD_CLEANUP_QUEUE,
} from './project-import-upload-cleanup.processor';
import { ProjectEventsModule } from './project-events.module';
import { AppService } from './app.service';
import { AppReadinessModule } from './app-readiness.module';
import { PROJECT_DUPLICATE_QUEUE } from './project-duplicate.types';
import { PROJECT_IMPORT_QUEUE } from './project-import.types';
import { PodModule } from '../pod/pod.module';
import { TimeoutModule } from '../timeout/timeout.module';
import { BifrostModule } from '../bifrost/bifrost.module';
import { GatewayModule } from '../gateway/gateway.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { ProxyService } from '../proxy/proxy.service';
import { GitModule } from '../git/git.module';
import { ProjectPoolModule } from '../pool/project-pool.module';
import { EnvironmentModule } from '../environment/environment.module';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { AgentSessionModule } from '../agent-session/agent-session.module';
import { ExternalServicesModule } from '../external-services';

@Module({
  imports: [
    BullModule.registerQueue({ name: PROJECT_DUPLICATE_QUEUE }),
    BullModule.registerQueue({ name: PROJECT_IMPORT_QUEUE }),
    BullModule.registerQueue({ name: PROJECT_IMPORT_UPLOAD_CLEANUP_QUEUE }),
    BullBoardModule.forFeature({
      name: PROJECT_DUPLICATE_QUEUE,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: PROJECT_IMPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: PROJECT_IMPORT_UPLOAD_CLEANUP_QUEUE,
      adapter: BullMQAdapter,
    }),
    PodModule,
    TimeoutModule,
    forwardRef(() => BifrostModule),
    GatewayModule,
    ProjectEventsModule,
    forwardRef(() => ScheduleModule),
    ProjectPoolModule,
    EnvironmentModule,
    ProjectEnvironmentModule,
    forwardRef(() => AgentSessionModule),
    ExternalServicesModule,
    GitModule,
    AppReadinessModule,
  ],
  controllers: [
    ProjectController,
    AppAgentController,
    AgentStatusController,
    AgentStatusStreamController,
    PodClassController,
    ProjectImportController,
    ProjectImportUploadController,
  ],
  providers: [
    ProjectService,
    ProjectAuthService,
    ProjectFilesService,
    ProjectDuplicateProcessor,
    ProjectImportService,
    ProjectImportUploadService,
    ProjectImportProcessor,
    ProjectImportUploadCleanupProcessor,
    ProxyService,
    AppService,
  ],
  exports: [
    ProjectService,
    ProjectAuthService,
    ProjectFilesService,
    ProjectImportService,
    ProjectImportUploadService,
    AppReadinessModule,
  ],
})
export class ProjectModule implements OnApplicationBootstrap {
  constructor(@InjectQueue(PROJECT_IMPORT_UPLOAD_CLEANUP_QUEUE) private readonly importUploadCleanupQueue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.importUploadCleanupQueue.upsertJobScheduler(
      'project-import-upload-cleanup-daily',
      { pattern: '0 3 * * *' },
      { name: 'cleanup' }
    );
  }
}
