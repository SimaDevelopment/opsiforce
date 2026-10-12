import { Module } from '@nestjs/common';
import { SecretSealer } from './secret-sealer';

@Module({
  providers: [SecretSealer],
  exports: [SecretSealer],
})
export class SealingModule {}
