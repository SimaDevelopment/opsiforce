import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { CallLogCleanupProcessor, EXTERNAL_SERVICE_CALL_LOG_CLEANUP_QUEUE } from './call-log-cleanup.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: EXTERNAL_SERVICE_CALL_LOG_CLEANUP_QUEUE }),
    BullBoardModule.forFeature({ name: EXTERNAL_SERVICE_CALL_LOG_CLEANUP_QUEUE, adapter: BullMQAdapter }),
  ],
  providers: [CallLogCleanupProcessor],
})
export class CallLogCleanupModule implements OnApplicationBootstrap {
  constructor(@InjectQueue(EXTERNAL_SERVICE_CALL_LOG_CLEANUP_QUEUE) private readonly cleanupQueue: Queue) {}

  async onApplicationBootstrap() {
    await this.cleanupQueue.upsertJobScheduler(
      'external-service-call-log-cleanup-daily',
      { pattern: '30 4 * * *' },
      { name: 'cleanup' }
    );
  }
}
