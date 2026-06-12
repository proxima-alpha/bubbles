import { Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { OllamaProvider, LlmMessage } from './providers/ollama.provider';

@Injectable()
export class ModelService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private ollamaProvider: OllamaProvider,
  ) {}

  async getModelInfo(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { model_code: true },
    });
    if (!user?.model) throw new ForbiddenException('No model selected');
    const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
    return { model: user.model, baseUrl, provider: user.model_code?.parent_code ?? 'unknown' };
  }

  async *chatStream(
    userId: string,
    messages: LlmMessage[],
  ): AsyncGenerator<string, { inputTokens: number | null; outputTokens: number | null }, unknown> {
    const { model, baseUrl } = await this.getModelInfo(userId);
    return yield* this.ollamaProvider.chatStream(baseUrl, model, messages);
  }

  async embedText(text: string): Promise<number[]> {
    const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.ollamaProvider.embed(baseUrl, text);
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error('unreachable');
  }
}
