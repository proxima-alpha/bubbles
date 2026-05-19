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

    const userMsg = await this.prisma.message.create({
      data: { user_id: userId, role: 'user', content: dto.content },
    });

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.modelService.embedText(dto.content);
      await this.prisma.$executeRaw`
        UPDATE message SET embedding = ${queryEmbedding}::vector WHERE id = ${userMsg.id}::uuid
      `;
    } catch {
      res.status(503).json({ message: '잠시 후 재시도해주세요.' });
      return;
    }

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

    const stream = this.modelService.chatStream(userId, messages);
    let tokenCounts = { inputTokens: null as number | null, outputTokens: null as number | null };

    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        tokenCounts = value ?? tokenCounts;
        break;
      }
      fullContent += value;
      res.write(`data: ${JSON.stringify({ token: value })}\n\n`);
    }

    const assistantMsg = await this.prisma.message.create({
      data: {
        user_id: userId,
        role: 'assistant',
        provider,
        model,
        content: fullContent,
        input_tokens: tokenCounts.inputTokens,
        output_tokens: tokenCounts.outputTokens,
      },
    });

    void this.modelService.embedText(fullContent)
      .then(vec => this.prisma.$executeRaw`
        UPDATE message SET embedding = ${vec}::vector WHERE id = ${assistantMsg.id}::uuid
      `)
      .catch(e => console.error('assistant embed failed', e));

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
