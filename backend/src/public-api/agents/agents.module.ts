import { Module } from '@nestjs/common';
import { ProjectEventsModule } from '../../project/project-events.module';
import { PublicApiAuthModule } from '../auth/public-api-auth.module';
import { AgentsController } from './agents.controller';
import { PublicAgentsRepository } from './agents.repository';
import { PublicAgentsService } from './agents.service';

@Module({
  imports: [PublicApiAuthModule, ProjectEventsModule],
  controllers: [AgentsController],
  providers: [PublicAgentsRepository, PublicAgentsService],
})
export class PublicApiAgentsModule {}
