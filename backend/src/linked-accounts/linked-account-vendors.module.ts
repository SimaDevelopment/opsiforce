import { Module } from '@nestjs/common';
import { LinkedAccountVendorsService } from './linked-account-vendors.service';

@Module({
  providers: [LinkedAccountVendorsService],
  exports: [LinkedAccountVendorsService],
})
export class LinkedAccountVendorsModule {}
