import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClaudeProvider, LlmMessage, LlmResponse } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';

@Injectable()
export class ModelService {
  constructor(
    private prisma: PrismaService,
    private claudeProvider: ClaudeProvider,
    private openAiProvider: OpenAiProvider,
  ) {}

  async chat(userId: string, messages: LlmMessage[]): Promise<LlmResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { license_keys: true },
    });
    if (!user?.model) throw new ForbiddenException('No model selected');

    const modelCode = await this.prisma.common_code.findUnique({
      where: { category_code_code: { category_code: 'model', code: user.model } },
    });
    if (!modelCode?.parent_code) throw new NotFoundException('Model provider not found');

    const provider = modelCode.parent_code;
    const licenseKey = user.license_keys.find(lk => lk.provider === provider);
    if (!licenseKey) throw new ForbiddenException('No API key for this provider');

    if (provider === 'claude') {
      return this.claudeProvider.chat(licenseKey.key, user.model, messages);
    }
    if (provider === 'gpt') {
      return this.openAiProvider.chat(licenseKey.key, user.model, messages);
    }

    throw new NotFoundException(`Unknown provider: ${provider}`);
  }
}
