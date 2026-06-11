import { Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ModelService } from '../model/model.service';
import { MemoryService } from '../memory/memory.service';
import { SendMessageDto } from './dto/send-message.dto';

function buildSystemPrompt(mainMemory: string | null, knowledgeItems: string[]): string {
  let prompt = '당신은 사용자를 깊이 이해하는 개인 AI 어시스턴트입니다.';
  if (mainMemory) prompt += `\n\n[사용자 기억]\n${mainMemory}`;
  if (knowledgeItems.length > 0) prompt += `\n\n[관련 지식]\n${knowledgeItems.join('\n---\n')}`;
  return prompt;
}

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private modelService: ModelService,
    private memoryService: MemoryService,
    private config: ConfigService,
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
      const queryVec = `[${queryEmbedding.join(',')}]`;
      await this.prisma.$executeRaw`
        UPDATE message SET embedding = ${queryVec}::vector WHERE id = ${userMsg.id}::uuid
      `;
    } catch (e) {
      res.status(503).json({ message: '잠시 후 재시도해주세요.' });
      return;
    }

    const topK = this.config.get<number>('RAG_TOP_K', 5);
    const [mainMemory, topKnowledge] = await Promise.all([
      this.memoryService.getActiveMainMemory(userId),
      this.memoryService.getTopKnowledge(userId, queryEmbedding, topK),
    ]);

    const systemPrompt = buildSystemPrompt(
      mainMemory,
      topKnowledge.map(m => m.summary),
    );

    const recentMessages = await this.prisma.message.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 20,
    });

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...recentMessages.reverse().map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

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
        UPDATE message SET embedding = ${`[${vec.join(',')}]`}::vector WHERE id = ${assistantMsg.id}::uuid
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

    const providerCodes = [...new Set(messages.map(m => m.provider).filter((v): v is string => v !== null))];
    const modelCodes = [...new Set(messages.map(m => m.model).filter((v): v is string => v !== null))];

    const [providers, models] = await Promise.all([
      this.prisma.common_code.findMany({ where: { category_code: 'provider', code: { in: providerCodes } } }),
      this.prisma.common_code.findMany({ where: { category_code: 'model', code: { in: modelCodes } } }),
    ]);

    const providerMap = Object.fromEntries(providers.map(p => [p.code, p.name]));
    const modelMap = Object.fromEntries(models.map(m => [m.code, m.name]));

    return messages.map(m => ({
      id: m.id,
      role: m.role,
      provider: m.provider ? { code: m.provider, name: providerMap[m.provider] ?? m.provider } : null,
      model: m.model ? { code: m.model, name: modelMap[m.model] ?? m.model } : null,
      content: m.content,
      createdAt: m.created_at,
    }));
  }
}
