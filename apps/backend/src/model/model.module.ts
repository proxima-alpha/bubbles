import { Module } from '@nestjs/common';
import { ModelService } from './model.service';
import { OllamaProvider } from './providers/ollama.provider';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  providers: [ModelService, OllamaProvider],
  exports: [ModelService],
})
export class ModelModule {}
