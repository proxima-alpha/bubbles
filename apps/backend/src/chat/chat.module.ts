import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ModelModule } from '../model/model.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [PrismaModule, ModelModule, MemoryModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
