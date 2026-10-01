import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ProjectPoolService } from './project-pool.service';
import { ProjectPoolProcessor } from './project-pool.processor';
import { ProjectPoolTeardownProcessor } from './project-pool-teardown.processor';
import { PROJECT_POOL_QUEUE, PROJECT_POOL_TEARDOWN_QUEUE } from './project-pool.types';
import { PodModule } from '../pod/pod.module';
import { BifrostModule } from '../bifrost/bifrost.module';
import { GatewayModule } from '../gateway/gateway.module';
import { TimeoutModule } from '../timeout/timeout.module';
import { EnvironmentModule } from '../environment/environment.module';
import { ExternalServicesModule } from '../external-services';
import { ModelProvidersModule } from '../model-provider/model-provider.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: PROJECT_POOL_QUEUE }),
    BullModule.registerQueue({ name: PROJECT_POOL_TEARDOWN_QUEUE }),
    BullBoardModule.forFeature({ name: PROJECT_POOL_QUEUE, adapter: BullMQAdapter }),
    BullBoardModule.forFeature({ name: PROJECT_POOL_TEARDOWN_QUEUE, adapter: BullMQAdapter }),
    PodModule,
    forwardRef(() => BifrostModule),
    GatewayModule,
    TimeoutModule,
    EnvironmentModule,
    ExternalServicesModule,
    forwardRef(() => ModelProvidersModule),
  ],
  providers: [ProjectPoolService, ProjectPoolProcessor, ProjectPoolTeardownProcessor],
  exports: [ProjectPoolService],
})
export class ProjectPoolModule {}
