import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ModelModule } from '../model/model.module';

@Module({
  imports: [PrismaModule, ModelModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
