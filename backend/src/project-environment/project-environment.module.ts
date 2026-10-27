import { Module } from '@nestjs/common';
import { PodModule } from '../pod/pod.module';
import { ProjectEnvironmentService } from './project-environment.service';
import { EnvironmentVariablesService } from './environment-variables.service';
import { PublicUrlService } from './public-url.service';

@Module({
  imports: [PodModule],
  providers: [ProjectEnvironmentService, EnvironmentVariablesService, PublicUrlService],
  exports: [ProjectEnvironmentService, EnvironmentVariablesService, PublicUrlService],
})
export class ProjectEnvironmentModule {}
