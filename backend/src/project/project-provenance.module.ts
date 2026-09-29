import { Module } from '@nestjs/common';
import { ProjectProvenanceRepository } from './project-provenance.repository';

@Module({
  providers: [ProjectProvenanceRepository],
  exports: [ProjectProvenanceRepository],
})
export class ProjectProvenanceModule {}
