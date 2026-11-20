import { Module } from '@nestjs/common';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { SealingModule } from '../sealing/sealing.module';
import { AppUserLinksService } from './app-user-links.service';
import { AppUserMailer } from './app-user-mailer';
import { AppUserRolesService } from './app-user-roles.service';
import { AppUserSigningKey } from './app-user-signing-key';
import { AppUsersProviderController } from './app-users-provider.controller';
import { AppUsersProviderService } from './app-users-provider.service';
import { AppUsersService } from './app-users.service';

@Module({
  imports: [SealingModule, ProjectEnvironmentModule],
  controllers: [AppUsersProviderController],
  providers: [
    AppUsersService,
    AppUserRolesService,
    AppUserLinksService,
    AppUserMailer,
    AppUsersProviderService,
    AppUserSigningKey,
  ],
  exports: [AppUsersService, AppUserRolesService, AppUserLinksService, AppUserMailer],
})
export class AppUsersModule {}
