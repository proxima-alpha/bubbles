import { Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ModelService } from '../model/model.service';
import { SystemChatService } from '../model/system-chat.service';
import { MemoryService } from '../memory/memory.service';
import { ChatRepository } from './chat.repository';
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
    private chatRepo: ChatRepository,
    private modelService: ModelService,
    private systemChatService: SystemChatService,
    private memoryService: MemoryService,
    private config: ConfigService,
  ) {}

  async sendMessageStream(userId: string, dto: SendMessageDto, res: Response) {
    const user = await this.chatRepo.findUserById(userId);
    if (!user?.model) throw new ForbiddenException('No model selected');

    const userMsg = await this.chatRepo.createMessage({ user_id: userId, role: 'user', content: dto.content });

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.modelService.embedTextChunked(dto.content, 'search_query: ');
    } catch (e) {
      res.status(503).json({ message: '잠시 후 재시도해주세요.' });
      return;
    }

    const topK = Number(this.config.get('RAG_TOP_K', 5));
    const [mainMemory, topKnowledge] = await Promise.all([
      this.memoryService.getActiveMainMemory(userId),
      this.memoryService.getTopKnowledge(userId, queryEmbedding, topK),
    ]);

    const systemPrompt = buildSystemPrompt(mainMemory, topKnowledge.map(m => m.summary));

    const recentMessages = await this.chatRepo.findRecentMessages(userId, 20);

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...recentMessages.reverse().map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const { model, provider, modelCode, providerCode } = await this.modelService.getModelInfo(userId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ type: 'meta', provider: providerCode, model: modelCode })}\n\n`);

    let fullContent = '';
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

    const assistantMsg = await this.chatRepo.createMessage({
      user_id: userId,
      role: 'assistant',
      provider,
      model,
      content: fullContent,
      input_tokens: tokenCounts.inputTokens,
      output_tokens: tokenCounts.outputTokens,
      parent_message_id: userMsg.id,
    });

    void this.generateMessageContents(userId, dto.content, fullContent, assistantMsg.id)
      .catch(e => console.error('summary/embed failed', e));

    res.write(`data: [DONE]\n\n`);
    res.end();
  }

  async getHistory(userId: string) {
    const messages = await this.chatRepo.findHistory(userId);

    return messages.map(m => ({
      id: m.id,
      role: m.role,
      provider: m.provider_code ? { code: m.provider_code.code, name: m.provider_code.name } : null,
      model: m.model_code ? { code: m.model_code.code, name: m.model_code.name } : null,
      content: m.content,
      createdAt: m.created_at,
    }));
  }

  async generateMessageContents(userId: string, questionContent: string, answerContent: string, assistantMessageId: string) {
    const contents = await this.systemChatService.generateMessageContents(userId, questionContent, answerContent);
    if (contents.length === 0) return;

    const embeddings = await this.modelService.embedTextsChunked(contents, 'search_document: ');

    await this.chatRepo.insertMessageContents(
      assistantMessageId,
      contents.map((content, seq) => ({ seq, content, embedding: embeddings[seq] })),
    );
  }
}
