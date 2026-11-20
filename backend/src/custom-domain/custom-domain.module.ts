import { Module } from '@nestjs/common';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { CustomDomainCluster } from './custom-domain-cluster';
import { CustomDomainController } from './custom-domain.controller';
import { CustomDomainService } from './custom-domain.service';
import { publicDnsProvider } from './public-dns';

@Module({
  imports: [ProjectEnvironmentModule],
  controllers: [CustomDomainController],
  providers: [CustomDomainService, CustomDomainCluster, publicDnsProvider],
  exports: [CustomDomainService, CustomDomainCluster],
})
export class CustomDomainModule {}
