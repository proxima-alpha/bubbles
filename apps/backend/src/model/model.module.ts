import { Module } from '@nestjs/common';
import { ModelService } from './model.service';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ModelService, ClaudeProvider, OpenAiProvider],
  exports: [ModelService],
})
export class ModelModule {}
