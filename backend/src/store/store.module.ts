import { Global, Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module';
import { SkillAvailability } from './skill-availability';
import { SkillPublishService } from './skill-publish.service';
import { SkillReconcilerService } from './skill-reconciler.service';
import { SkillRepository } from './skill.repository';
import { SkillService } from './skill.service';
import { SkillsController } from './skills.controller';

@Global()
@Module({
  imports: [ProjectModule],
  controllers: [SkillsController],
  providers: [SkillAvailability, SkillReconcilerService, SkillRepository, SkillPublishService, SkillService],
  exports: [SkillAvailability, SkillReconcilerService, SkillRepository, SkillPublishService, SkillService],
})
export class StoreModule {}
