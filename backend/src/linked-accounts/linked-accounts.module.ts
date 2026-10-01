import { Module } from '@nestjs/common';
import { ModelProvidersModule } from '../model-provider/model-provider.module';
import { LinkedAccountCredentialController } from './linked-account-credential.controller';
import { LinkedAccountVendorsModule } from './linked-account-vendors.module';
import { LinkedAccountsService } from './linked-accounts.service';
import { PlatformLinkedAccountsController } from './platform-linked-accounts.controller';
import { TenantLinkedAccountsController } from './tenant-linked-accounts.controller';

@Module({
  imports: [ModelProvidersModule, LinkedAccountVendorsModule],
  controllers: [TenantLinkedAccountsController, PlatformLinkedAccountsController, LinkedAccountCredentialController],
  providers: [LinkedAccountsService],
})
export class LinkedAccountsModule {}
