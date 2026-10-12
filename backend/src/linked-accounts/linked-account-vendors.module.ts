import { Module } from '@nestjs/common';
import { SealingModule } from '../sealing/sealing.module';
import { LinkedAccountVendorsService } from './linked-account-vendors.service';

@Module({
  imports: [SealingModule],
  providers: [LinkedAccountVendorsService],
  exports: [LinkedAccountVendorsService],
})
export class LinkedAccountVendorsModule {}
