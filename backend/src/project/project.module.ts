import { Module, forwardRef, type OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Queue } from 'bullmq';
import { ProjectController } from './project.controller';
import { ProjectAppUsersController } from './project-app-users.controller';
import { AppUsersModule } from '../app-users/app-users.module';
import { AppAgentController } from './app.controller.agent';
import { AgentObservationsController } from './agent-observations.controller';
import { AgentObservationsService } from './agent-observations.service';
import { AgentStatusStreamController } from './agent-status-stream.controller';
import { PodClassController } from './pod-class.controller';
import { ProjectService } from './project.service';
import { AppAuthRouteReconciler } from './app-auth-route.reconciler';
import { AppSlugBackfill } from './app-slug-backfill';
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
import { InactivityCleanupProcessor, INACTIVITY_CLEANUP_QUEUE } from './inactivity-cleanup.processor';
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
import { ModelProvidersModule } from '../model-provider/model-provider.module';
import { SealingModule } from '../sealing/sealing.module';
import { CustomDomainModule } from '../custom-domain/custom-domain.module';

@Module({
  imports: [
    AppUsersModule,
    BullModule.registerQueue({ name: PROJECT_DUPLICATE_QUEUE }),
    BullModule.registerQueue({ name: PROJECT_IMPORT_QUEUE }),
    BullModule.registerQueue({ name: PROJECT_IMPORT_UPLOAD_CLEANUP_QUEUE }),
    BullModule.registerQueue({ name: INACTIVITY_CLEANUP_QUEUE }),
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
    BullBoardModule.forFeature({
      name: INACTIVITY_CLEANUP_QUEUE,
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
    forwardRef(() => ModelProvidersModule),
    GitModule,
    SealingModule,
    AppReadinessModule,
    CustomDomainModule,
  ],
  controllers: [
    ProjectController,
    ProjectAppUsersController,
    AppAgentController,
    AgentObservationsController,
    AgentStatusStreamController,
    PodClassController,
    ProjectImportController,
    ProjectImportUploadController,
  ],
  providers: [
    ProjectService,
    ProjectAuthService,
    AppAuthRouteReconciler,
    // TODO: remove in the release after readable Public URLs ship: AppSlugBackfill, with its describe block in test/public-url/existing-app-slugs.test.ts and its bullets in docs/projects/public-url.md and ADR-0012; the Switch prompt and suggestedAppSlug stay
    AppSlugBackfill,
    ProjectFilesService,
    ProjectDuplicateProcessor,
    ProjectImportService,
    ProjectImportUploadService,
    ProjectImportProcessor,
    ProjectImportUploadCleanupProcessor,
    InactivityCleanupProcessor,
    ProxyService,
    AppService,
    AgentObservationsService,
  ],
  exports: [
    ProjectService,
    ProjectAuthService,
    ProjectFilesService,
    ProjectImportService,
    ProjectImportUploadService,
    ProxyService,
    AppReadinessModule,
  ],
})
export class ProjectModule implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(PROJECT_IMPORT_UPLOAD_CLEANUP_QUEUE) private readonly importUploadCleanupQueue: Queue,
    @InjectQueue(INACTIVITY_CLEANUP_QUEUE) private readonly inactivityCleanupQueue: Queue
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.importUploadCleanupQueue.upsertJobScheduler(
      'project-import-upload-cleanup-daily',
      { pattern: '0 3 * * *' },
      { name: 'cleanup' }
    );
    await this.inactivityCleanupQueue.upsertJobScheduler(
      'project-inactivity-cleanup-hourly',
      { pattern: '17 * * * *', tz: 'UTC' },
      { name: 'cleanup' }
    );
  }
}
