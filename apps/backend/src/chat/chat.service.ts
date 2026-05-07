import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ModelService } from '../model/model.service';
import { SendMessageDto } from './dto/send-message.dto';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private modelService: ModelService,
  ) {}

  async sendMessage(userId: string, dto: SendMessageDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.model) throw new ForbiddenException('No model selected');

    await this.prisma.message.create({
      data: { user_id: userId, role: 'user', content: dto.content },
    });

    const recentMessages = await this.prisma.message.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 20,
    });

    const messages = recentMessages.reverse().map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const response = await this.modelService.chat(userId, messages);

    await this.prisma.message.create({
      data: {
        user_id: userId,
        role: 'assistant',
        provider: response.provider,
        model: response.model,
        content: response.content,
      },
    });

    return {
      content: response.content,
      provider: response.provider,
      model: response.model,
    };
  }

  async getHistory(userId: string) {
    const messages = await this.prisma.message.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'asc' },
    });

    return messages.map(m => ({
      id: m.id,
      role: m.role,
      provider: m.provider,
      model: m.model,
      content: m.content,
      createdAt: m.created_at,
    }));
  }
}
