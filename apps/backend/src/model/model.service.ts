import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { OllamaProvider, LlmMessage, LlmResponse } from './providers/ollama.provider';

@Injectable()
export class ModelService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private ollamaProvider: OllamaProvider,
  ) {}

  async chat(userId: string, messages: LlmMessage[]): Promise<LlmResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.model) throw new ForbiddenException('No model selected');

    const modelCode = await this.prisma.common_code.findUnique({
      where: { category_code_code: { category_code: 'model', code: user.model } },
    });
    if (!modelCode?.parent_code) throw new NotFoundException('Model provider not found');

    const provider = modelCode.parent_code;

    if (provider === 'ollama') {
      const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
      return this.ollamaProvider.chat(baseUrl, user.model, messages);
    }

    throw new NotFoundException(`Unknown provider: ${provider}`);
  }
}
