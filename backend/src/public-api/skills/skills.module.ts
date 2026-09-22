import { Module } from '@nestjs/common';
import { ProjectEventsModule } from '../../project/project-events.module';
import { PublicApiAuthModule } from '../auth/public-api-auth.module';
import { SkillsController } from './skills.controller';
import { PublicSkillsService } from './skills.service';

@Module({
  imports: [PublicApiAuthModule, ProjectEventsModule],
  controllers: [SkillsController],
  providers: [PublicSkillsService],
})
export class PublicApiSkillsModule {}
