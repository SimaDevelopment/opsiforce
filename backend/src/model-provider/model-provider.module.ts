import { Module, forwardRef } from '@nestjs/common';
import { BifrostModule } from '../bifrost/bifrost.module';
import { LinkedAccountVendorsModule } from '../linked-accounts/linked-account-vendors.module';
import { AzureConnectionsService } from './azure-connections.service';
import { ModelProviderConnectionsService } from './model-provider-connections.service';
import { ModelProviderCreationController } from './model-provider-creation.controller';
import { ModelProviderCreationService } from './model-provider-creation.service';
import { ModelProviderKeyModelsService } from './model-provider-key-models.service';
import { ModelProvidersController } from './model-provider.controller';
import { ModelProvidersService } from './model-provider.service';
import { PlatformModelProvidersController } from './platform-model-providers.controller';
import { PlatformModelProvidersService } from './platform-model-providers.service';
import { ReachableModelsController } from './reachable-models.controller';

@Module({
  imports: [forwardRef(() => BifrostModule), LinkedAccountVendorsModule],
  controllers: [
    ModelProvidersController,
    ReachableModelsController,
    ModelProviderCreationController,
    PlatformModelProvidersController,
  ],
  providers: [
    AzureConnectionsService,
    ModelProvidersService,
    ModelProviderConnectionsService,
    ModelProviderCreationService,
    ModelProviderKeyModelsService,
    PlatformModelProvidersService,
  ],
  exports: [ModelProvidersService, ModelProviderConnectionsService, ModelProviderKeyModelsService],
})
export class ModelProvidersModule {}
