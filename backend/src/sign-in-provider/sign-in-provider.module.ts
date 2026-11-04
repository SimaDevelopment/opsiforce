import { Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module';
import { SealingModule } from '../sealing/sealing.module';
import { SignInProvidersService } from './sign-in-provider.service';
import { SignInProvidersController } from './sign-in-provider.controller';

@Module({
  imports: [ProjectModule, SealingModule],
  controllers: [SignInProvidersController],
  providers: [SignInProvidersService],
})
export class SignInProvidersModule {}
