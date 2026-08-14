import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ModelModule } from '../model/model.module';
import { MemoryModule } from '../memory/memory.module';
import { MessageModule } from '../message/message.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [ModelModule, MemoryModule, MessageModule, UserModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
