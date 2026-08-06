import { Module } from '@nestjs/common';
import { ModelService } from './model.service';
import { SystemChatService } from './system-chat.service';
import { OllamaProvider } from './providers/ollama.provider';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  providers: [ModelService, SystemChatService, OllamaProvider],
  exports: [ModelService, SystemChatService],
})
export class ModelModule {}
