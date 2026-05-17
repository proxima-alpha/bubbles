import { Injectable, ForbiddenException } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ModelService } from '../model/model.service';
import { SendMessageDto } from './dto/send-message.dto';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private modelService: ModelService,
  ) {}

  async sendMessageStream(userId: string, dto: SendMessageDto, res: Response) {
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

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullContent = '';
    const { model, provider } = await this.modelService.getModelInfo(userId);

    for await (const token of this.modelService.chatStream(userId, messages)) {
      fullContent += token;
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    await this.prisma.message.create({
      data: { user_id: userId, role: 'assistant', provider, model, content: fullContent },
    });

    res.write(`data: [DONE]\n\n`);
    res.end();
  }

  async getHistory(userId: string) {
    const messages = await this.prisma.message.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
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
