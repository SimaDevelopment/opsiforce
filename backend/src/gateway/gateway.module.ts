import { Module } from '@nestjs/common';
import { GatewayKeyService } from './gateway-key.service';
import { GatewayAuthGuard } from './gateway-auth.guard';

@Module({
  providers: [GatewayKeyService, GatewayAuthGuard],
  exports: [GatewayKeyService],
})
export class GatewayModule {}
