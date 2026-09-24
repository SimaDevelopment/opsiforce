import { Module } from '@nestjs/common';
import { BuilderModule } from '../../builder/builder.module';
import { ProjectEventsModule } from '../../project/project-events.module';
import { PublicApiAuthModule } from '../auth/public-api-auth.module';
import { MeController } from './me.controller';

@Module({ imports: [PublicApiAuthModule, ProjectEventsModule, BuilderModule], controllers: [MeController] })
export class MeModule {}
