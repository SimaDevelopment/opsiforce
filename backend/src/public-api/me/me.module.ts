import { Module } from '@nestjs/common';
import { ProjectEventsModule } from '../../project/project-events.module';
import { PublicApiAuthModule } from '../auth/public-api-auth.module';
import { MeController } from './me.controller';

@Module({ imports: [PublicApiAuthModule, ProjectEventsModule], controllers: [MeController] })
export class MeModule {}
