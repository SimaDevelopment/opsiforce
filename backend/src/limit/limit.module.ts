import { Module } from '@nestjs/common';
import { LimitController } from './limit.controller';
import { LimitService } from './limit.service';

@Module({
  controllers: [LimitController],
  providers: [LimitService],
})
export class LimitModule {}
