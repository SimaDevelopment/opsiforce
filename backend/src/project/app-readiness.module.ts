import { Module } from '@nestjs/common';
import { AppReadinessService } from './app-readiness.service';
import { ProjectEventsModule } from './project-events.module';

@Module({
  imports: [ProjectEventsModule],
  providers: [AppReadinessService],
  exports: [AppReadinessService],
})
export class AppReadinessModule {}
