import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { EXTERNAL_SERVICE_DOORBELL_QUEUE } from './doorbell.types';

const doorbellQueue = BullModule.registerQueue({ name: EXTERNAL_SERVICE_DOORBELL_QUEUE });

@Global()
@Module({
  imports: [
    doorbellQueue,
    BullBoardModule.forFeature({ name: EXTERNAL_SERVICE_DOORBELL_QUEUE, adapter: BullMQAdapter }),
  ],
  exports: [doorbellQueue],
})
export class DoorbellQueueModule {}
