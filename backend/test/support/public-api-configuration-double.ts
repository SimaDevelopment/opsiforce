import { Global, Module } from '@nestjs/common';
import { ProjectConfigurationStore } from '../../src/external-services/configuration/project-configuration.store';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';

const publicApi = { id: 'public-api-double', slug: 'public-api', manifest: { operations: {} } };

@Global()
@Module({
  providers: [
    {
      provide: ServiceRegistry,
      useValue: { bySlug: (slug: string) => (slug === publicApi.slug ? publicApi : undefined) },
    },
    { provide: ProjectConfigurationStore, useValue: { startWith: () => Promise.resolve() } },
  ],
  exports: [ServiceRegistry, ProjectConfigurationStore],
})
export class PublicApiConfigurationDoubleModule {}
