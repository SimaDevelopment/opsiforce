import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { PodOpencodeClient } from '../agent-session/pod-opencode.client';
import { GitModule } from '../git/git.module';
import { PodModule } from '../pod/pod.module';
import { DeliveryRepository } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { EnvironmentSkillsService } from './environment-skills';
import { SKILL_DELIVERY_QUEUE } from './delivery.types';
import { PodReloadClient } from './pod-reload.client';
import { RetiredSkillSweep } from './retired-skill-sweep';
import { SkillDeliveryProcessor } from './skill-delivery.processor';
import { SkillDeliveryRepository } from './skill-delivery.repository';
import { SkillDeliveryService } from './skill-delivery.service';
import { SkillSwitchRepository } from './skill-switch.repository';
import { WorkspaceWriter } from './workspace-writer';

@Global()
@Module({
  imports: [
    GitModule,
    PodModule,
    BullModule.registerQueue({ name: SKILL_DELIVERY_QUEUE }),
    BullBoardModule.forFeature({ name: SKILL_DELIVERY_QUEUE, adapter: BullMQAdapter }),
  ],
  providers: [
    DeliveryRepository,
    DeliveryService,
    EnvironmentSkillsService,
    PodOpencodeClient,
    PodReloadClient,
    RetiredSkillSweep,
    SkillDeliveryProcessor,
    SkillDeliveryRepository,
    SkillDeliveryService,
    SkillSwitchRepository,
    WorkspaceWriter,
  ],
  exports: [
    DeliveryService,
    EnvironmentSkillsService,
    PodReloadClient,
    SkillDeliveryRepository,
    SkillDeliveryService,
    SkillSwitchRepository,
    WorkspaceWriter,
  ],
})
export class DeliveryModule {}
