import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PublicApiAgentsModule } from './agents/agents.module';
import { MeModule } from './me/me.module';
import { PublicApiProjectsModule } from './projects/projects.module';
import { PublicApiPrefixFilter } from './errors/error-details.filter';

export const PUBLIC_API_RESOURCE_MODULES = [MeModule, PublicApiAgentsModule, PublicApiProjectsModule];

@Module({
  imports: PUBLIC_API_RESOURCE_MODULES,
  providers: [{ provide: APP_FILTER, useClass: PublicApiPrefixFilter }],
})
export class PublicApiModule {}
