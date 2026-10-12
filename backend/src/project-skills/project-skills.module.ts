import { Module } from '@nestjs/common';
import { ProjectSkillsController } from './project-skills.controller';

@Module({ controllers: [ProjectSkillsController] })
export class ProjectSkillsModule {}
