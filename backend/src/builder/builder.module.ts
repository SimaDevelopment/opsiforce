import { Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module';
import { BuilderChatRepository } from './builder-chat.repository';
import { BuilderChatService } from './builder-chat.service';
import { BuilderController } from './builder.controller';

@Module({
  imports: [ProjectModule],
  controllers: [BuilderController],
  providers: [BuilderChatRepository, BuilderChatService],
  exports: [BuilderChatService],
})
export class BuilderModule {}
