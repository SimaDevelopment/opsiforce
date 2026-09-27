import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { PodOpencodeClient } from '../agent-session/pod-opencode.client';
import { PodModule } from '../pod/pod.module';
import { DeliveryRepository } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { SKILL_DELIVERY_QUEUE } from './delivery.types';
import { PodReloadClient } from './pod-reload.client';
import { SkillDeliveryProcessor } from './skill-delivery.processor';
import { SkillDeliveryRepository } from './skill-delivery.repository';
import { SkillDeliveryService } from './skill-delivery.service';
import { WorkspaceWriter } from './workspace-writer';

@Global()
@Module({
  imports: [
    PodModule,
    BullModule.registerQueue({ name: SKILL_DELIVERY_QUEUE }),
    BullBoardModule.forFeature({ name: SKILL_DELIVERY_QUEUE, adapter: BullMQAdapter }),
  ],
  providers: [
    DeliveryRepository,
    DeliveryService,
    PodOpencodeClient,
    PodReloadClient,
    SkillDeliveryProcessor,
    SkillDeliveryRepository,
    SkillDeliveryService,
    WorkspaceWriter,
  ],
  exports: [DeliveryService, PodReloadClient, SkillDeliveryRepository, SkillDeliveryService, WorkspaceWriter],
})
export class DeliveryModule {}
