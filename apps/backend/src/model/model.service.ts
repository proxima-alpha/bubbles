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
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.model) throw new ForbiddenException('No model selected');
    const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
    return { model: user.model, baseUrl, provider: 'ollama' };
  }

  async *chatStream(userId: string, messages: LlmMessage[]): AsyncGenerator<string> {
    const { model, baseUrl } = await this.getModelInfo(userId);
    yield* this.ollamaProvider.chatStream(baseUrl, model, messages);
  }
}
