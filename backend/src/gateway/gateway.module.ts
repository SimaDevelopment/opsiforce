import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { GatewayKeyService } from './gateway-key.service';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { CallTokens } from './call-tokens';
import { ServiceProviderRegistry } from './providers/provider-registry';
import { EmailProvider } from './providers/email.provider';
import { SERVICE_PROVIDERS } from './providers/service-provider.interface';

@Module({
  controllers: [GatewayController],
  providers: [
    // TODO: remove in the release after External Services v2 ships: GatewayController, GatewayService, EmailProvider, SERVICE_PROVIDERS and ServiceProviderRegistry (the dead POST /api/gateway dispatcher); GatewayKeyService, GatewayAuthGuard and CallTokens stay
    GatewayService,
    GatewayKeyService,
    GatewayAuthGuard,
    EmailProvider,
    {
      provide: SERVICE_PROVIDERS,
      useFactory: (email: EmailProvider) => [email],
      inject: [EmailProvider],
    },
    ServiceProviderRegistry,
    CallTokens,
  ],
  exports: [GatewayKeyService, CallTokens],
})
export class GatewayModule {}
