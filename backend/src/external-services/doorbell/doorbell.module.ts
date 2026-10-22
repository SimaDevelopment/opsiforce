import { Module } from '@nestjs/common';
import { ProjectModule } from '../../project/project.module';
import { ExternalServicesModule } from '../external-services.module';
import { DoorbellProcessor } from './doorbell.processor';

@Module({
  imports: [ProjectModule, ExternalServicesModule],
  providers: [DoorbellProcessor],
})
export class DoorbellModule {}
