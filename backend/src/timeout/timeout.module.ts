import { Module } from '@nestjs/common';
import { TimeoutService } from './timeout.service';
import { TimeoutListener } from './timeout.listener';
import { PodModule } from '../pod/pod.module';
import { ProjectEventsModule } from '../project/project-events.module';
import { AppReadinessModule } from '../project/app-readiness.module';

@Module({
  imports: [PodModule, ProjectEventsModule, AppReadinessModule],
  providers: [TimeoutService, TimeoutListener],
  exports: [TimeoutService],
})
export class TimeoutModule {}
