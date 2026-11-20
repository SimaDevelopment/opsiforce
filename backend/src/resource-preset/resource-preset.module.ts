import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { ProjectModule } from '../project/project.module';
import { ProjectPoolModule } from '../pool/project-pool.module';
import { ResourcePresetController } from './resource-preset.controller';
import { ResourcePresetRestartProcessor } from './resource-preset-restart.processor';
import { ResourcePresetService } from './resource-preset.service';
import { RESOURCE_PRESET_RESTART_QUEUE } from './resource-preset.types';

@Module({
  imports: [
    BullModule.registerQueue({ name: RESOURCE_PRESET_RESTART_QUEUE }),
    BullBoardModule.forFeature({ name: RESOURCE_PRESET_RESTART_QUEUE, adapter: BullMQAdapter }),
    ProjectModule,
    ProjectEnvironmentModule,
    ProjectPoolModule,
  ],
  controllers: [ResourcePresetController],
  providers: [ResourcePresetService, ResourcePresetRestartProcessor],
})
export class ResourcePresetModule {}
