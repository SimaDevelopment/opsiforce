import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import type { ServiceManifest } from '@opsiforce/external-service-sdk/server';
import { ProjectConfigurationStore } from '../../src/external-services/configuration/project-configuration.store';
import { limitDefault, PublicApiSettings } from '../../src/external-services/configuration/public-api-settings';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';

const manifest = JSON.parse(
  readFileSync(join(shippedBuiltInServicesDir(), 'public-api', 'service.json'), 'utf8')
) as ServiceManifest;

const publicApi = { id: 'public-api-double', slug: 'public-api', manifest };

@Global()
@Module({
  providers: [
    {
      provide: ServiceRegistry,
      useValue: { bySlug: (slug: string) => (slug === publicApi.slug ? publicApi : undefined) },
    },
    { provide: ProjectConfigurationStore, useValue: { startWith: () => Promise.resolve() } },
    {
      provide: PublicApiSettings,
      useValue: {
        of: () => Promise.resolve(null),
        limitOf: (_settings: unknown, key: 'maxCreatedProjects' | 'maxCreatedAgents') => limitDefault(manifest, key),
        labelOf: (key: string) => key,
        unreachedProjectDetail: () => 'The calling Project does not reach this Project.',
        otherProjectNotDeletedDetail: () => 'The calling Project may delete only the Projects it created.',
      },
    },
  ],
  exports: [ServiceRegistry, ProjectConfigurationStore, PublicApiSettings],
})
export class PublicApiConfigurationDoubleModule {}
