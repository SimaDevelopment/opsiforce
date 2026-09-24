import { Global, Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module';
import { SkillPublishService } from './skill-publish.service';
import { SkillReconcilerService } from './skill-reconciler.service';
import { SkillRepository } from './skill.repository';
import { SkillService } from './skill.service';
import { SkillsController } from './skills.controller';

@Global()
@Module({
  imports: [ProjectModule],
  controllers: [SkillsController],
  providers: [SkillReconcilerService, SkillRepository, SkillPublishService, SkillService],
  exports: [SkillReconcilerService, SkillRepository, SkillPublishService, SkillService],
})
export class StoreModule {}
