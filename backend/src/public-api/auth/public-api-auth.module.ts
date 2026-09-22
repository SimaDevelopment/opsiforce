import { Module } from '@nestjs/common';
import { GatewayModule } from '../../gateway/gateway.module';
import { ProjectEventsModule } from '../../project/project-events.module';
import { ProjectProvenanceModule } from '../../project/project-provenance.module';
import { ChatEventsInterceptor } from './chat-events.interceptor';
import { PublicApiGuard } from './public-api.guard';

@Module({
  imports: [GatewayModule, ProjectProvenanceModule, ProjectEventsModule],
  providers: [PublicApiGuard, ChatEventsInterceptor],
  exports: [GatewayModule, ProjectProvenanceModule, PublicApiGuard, ChatEventsInterceptor],
})
export class PublicApiAuthModule {}
