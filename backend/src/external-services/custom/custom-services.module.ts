import { Global, Module } from '@nestjs/common';
import { EnvironmentModule } from '../../environment/environment.module';
import { GatewayModule } from '../../gateway/gateway.module';
import { GitModule } from '../../git/git.module';
import { ProjectModule } from '../../project/project.module';
import { PublishModule } from '../../publish/publish.module';
import { ServicePodWaker } from '../gate/service-pod-waker';
import { ConfigurationImpacts } from '../publishing/configuration-impacts';
import { ServiceEnvironmentManifests } from '../publishing/service-environment-manifests';
import { ServicePublishing } from '../publishing/service-publishing';
import { ServicePublishingController } from '../publishing/service-publishing.controller';
import { ServiceTestReports } from '../publishing/test-reports';
import { BuilderLane } from './builder-lane';
import { BuilderLaneController } from './builder-lane.controller';
import { CustomServicesController } from './custom-services.controller';
import { ServiceAppSeeder } from './service-app-seeder';
import { ServiceCopies } from './service-copies';
import { ServiceCopiesController } from './service-copies.controller';
import { CustomServices } from './custom-services.service';
import { ProjectPodWaker } from './project-pod-waker';

@Global()
@Module({
  imports: [ProjectModule, GatewayModule, PublishModule, GitModule, EnvironmentModule],
  controllers: [CustomServicesController, ServiceCopiesController, BuilderLaneController, ServicePublishingController],
  providers: [
    CustomServices,
    ServiceAppSeeder,
    ServiceCopies,
    BuilderLane,
    ConfigurationImpacts,
    ServiceTestReports,
    ServicePublishing,
    ServiceEnvironmentManifests,
    { provide: ServicePodWaker, useClass: ProjectPodWaker },
  ],
  exports: [ServicePodWaker],
})
export class CustomServicesModule {}
