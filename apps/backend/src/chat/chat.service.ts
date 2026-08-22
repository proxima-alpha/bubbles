import {ForbiddenException, Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Response} from 'express';
import {ModelService} from '../model/model.service';
import {SystemChatService} from '../model/system-chat.service';
import {MemoryService} from '../memory/memory.service';
import {MessageRepository} from '../message/message.repository';
import {UserRepository} from '../user/user.repository';
import {MessageContent} from './dto/message-content.dto';
import {ChatMessageRequest} from "./dto/chat-message-request";

function buildSystemPrompt(mainMemory: string | null, knowledgeItems: string[]): string {
  let prompt = '당신은 사용자를 깊이 이해하는 개인 AI 어시스턴트입니다.';
  if (mainMemory) prompt += `\n\n[사용자 기억]\n${mainMemory}`;
  if (knowledgeItems.length > 0) prompt += `\n\n[관련 지식]\n${knowledgeItems.join('\n---\n')}`;
  return prompt;
}

@Injectable()
export class ChatService {
  constructor(
    private messageRepo: MessageRepository,
    private userRepo: UserRepository,
    private modelService: ModelService,
    private systemChatService: SystemChatService,
    private memoryService: MemoryService,
    private config: ConfigService,
  ) {
  }

  async sendMessageStream(userId: string, dto: ChatMessageRequest, res: Response) {
    const user = await this.userRepo.findById(userId);
    if (!user?.model) throw new ForbiddenException('No model selected');

    const userMsg = await this.messageRepo.createMessage({user_id: userId, role: 'user', content: dto.content});

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.modelService.embedTextChunked(dto.content, 'search_query: ');
    } catch (e) {
      res.status(503).json({message: '잠시 후 재시도해주세요.'});
      return;
    }

    const topK = Number(this.config.get('RAG_TOP_K', 5));
    const [mainMemory, topKnowledge] = await Promise.all([
      this.memoryService.getActiveMainMemory(userId),
      this.memoryService.getTopKnowledge(userId, queryEmbedding, topK),
    ]);

    const systemPrompt = buildSystemPrompt(mainMemory, topKnowledge.map(m => m.summary));

    const recentMessages = await this.messageRepo.findRecentMessages(userId, 20);

    const messages = [
      {role: 'system' as const, content: systemPrompt},
      ...recentMessages.reverse().map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const {model, provider, modelCode, providerCode} = await this.modelService.getModelInfo(userId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({type: 'meta', provider: providerCode, model: modelCode})}\n\n`);

    let fullContent = '';
    const numPredict = Number(this.config.get('CHAT_NUM_PREDICT', 1024));
    const stream = this.modelService.chatStream(userId, messages, {num_predict: numPredict});
    let tokenCounts = {inputTokens: null as number | null, outputTokens: null as number | null};

    while (true) {
      const {value, done} = await stream.next();
      if (done) {
        tokenCounts = value ?? tokenCounts;
        break;
      }
      fullContent += value;
      res.write(`data: ${JSON.stringify({token: value})}\n\n`);
    }

    const assistantMsg = await this.messageRepo.createMessage({
      user_id: userId,
      role: 'assistant',
      provider,
      model,
      content: fullContent,
      input_tokens: tokenCounts.inputTokens,
      output_tokens: tokenCounts.outputTokens,
      parent_message_id: userMsg.id,
    });

    void this.generateMessageContents(userId, userMsg, assistantMsg)
      .catch(e => console.error('summary/embed failed', e));

    res.write(`data: [DONE]\n\n`);
    res.end();
  }

  async getHistory(userId: string) {
    const messages = await this.messageRepo.findHistory(userId);

    return messages.map(m => ({
      id: m.id,
      role: m.role,
      provider: m.provider_code ? {code: m.provider_code.code, name: m.provider_code.name} : null,
      model: m.model_code ? {code: m.model_code.code, name: m.model_code.name} : null,
      content: m.content,
      createdAt: m.created_at,
    }));
  }

  async generateMessageContents(userId: string, question: MessageContent, answer: MessageContent) {
    const contents = await this.systemChatService.generateMessageContent(userId, question.content, answer.content);
    if (contents.length === 0) return;

    const questionEmbeddings = await this.modelService.embedText(question.content, 'search_document: ');
    await this.messageRepo.updateMessageEmbedding(
      question.id,
      questionEmbeddings,
    );

    const answerEmbeddings = await this.modelService.embedTexts(contents.map(c => c.text), 'search_document: ');

    await this.messageRepo.insertMessageContents(
      answer.id,
      contents.map((content, seq) => ({
        seq,
        content: content.text,
        weight: content.weight,
        embedding: answerEmbeddings[seq]
      })),
    );
  }
}
