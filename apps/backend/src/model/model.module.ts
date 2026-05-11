import { Module } from '@nestjs/common';
import { ModelService } from './model.service';
import { OllamaProvider } from './providers/ollama.provider';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ModelService, OllamaProvider],
  exports: [ModelService],
})
export class ModelModule {}
