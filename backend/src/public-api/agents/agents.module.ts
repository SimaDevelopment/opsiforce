import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { PublicAgentsRepository } from './agents.repository';

@Module({ controllers: [AgentsController], providers: [PublicAgentsRepository] })
export class PublicApiAgentsModule {}
