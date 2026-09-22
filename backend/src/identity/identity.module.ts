import { Global, Module } from '@nestjs/common';
import { ForwardedIdentityService } from './forwarded-identity.service';

@Global()
@Module({
  providers: [ForwardedIdentityService],
  exports: [ForwardedIdentityService],
})
export class IdentityModule {}
