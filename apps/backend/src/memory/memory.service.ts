import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { MemoryRepository } from './memory.repository';
import { ModelService } from '../model/model.service';
import { SystemChatService } from '../model/system-chat.service';

@Injectable()
export class MemoryService {
  constructor(
    private memoryRepo: MemoryRepository,
    private modelService: ModelService,
    private systemChatService: SystemChatService,
  ) {}

  async getActiveMainMemory(userId: string): Promise<string | null> {
    return this.memoryRepo.getActiveMainMemory(userId);
  }

  async getTopKnowledge(userId: string, embedding: number[], topK: number): Promise<{ id: string; summary: string }[]> {
    return this.memoryRepo.getTopKnowledge(userId, embedding, topK);
  }

  async getKnowledgeList(userId: string) {
    const memories = await this.memoryRepo.getKnowledgeList(userId);
    return memories.map(m => this.formatKnowledge(m));
  }

  async getKnowledgeDetail(userId: string, id: string) {
    const memory = await this.memoryRepo.findKnowledgeMemory(userId, id);
    return memory ? this.formatKnowledge(memory) : null;
  }

  async getKnowledgeHistory(userId: string, id: string) {
    const memories = await this.memoryRepo.findMemoryHistory(userId, id);
    return memories.map(m => this.formatKnowledge(m));
  }

  async getContentMessages(userId: string, contentId: string) {
    return this.memoryRepo.findContentMessages(userId, contentId);
  }

  async getKeywordDashboard(userId: string) {
    return this.memoryRepo.getKeywordDashboard(userId);
  }

  async getKnowledgeByKeyword(userId: string, code: string) {
    const memories = await this.memoryRepo.getKnowledgeByKeyword(userId, code);
    return memories.map(m => this.formatKnowledge(m));
  }

  async getMainMemory(userId: string) {
    const main = await this.memoryRepo.findMainMemory(userId);
    return { summary: main?.summary ?? null, updatedAt: main?.created_at ?? null };
  }

  async updateMainMemory(userId: string, summary: string) {
    const existing = await this.memoryRepo.findMainMemory(userId);
    await this.memoryRepo.saveMainMemory(userId, summary, existing, 'modified');
    return this.getMainMemory(userId);
  }

  async updateKnowledge(userId: string, id: string, contents: string[], summary: string) {
    const result = await this.memoryRepo.updateKnowledgeMemory(userId, id, contents, summary);
    if (!result) throw new NotFoundException();
    return this.getKnowledgeDetail(userId, result.id);
  }

  async deleteKnowledge(userId: string, id: string) {
    const result = await this.memoryRepo.deleteKnowledgeMemory(userId, id);
    if (!result) throw new NotFoundException();
  }

  async togglePin(userId: string, id: string) {
    let result;
    try {
      result = await this.memoryRepo.togglePin(userId, id);
    } catch (e) {
      if (e instanceof Error && e.message === 'PIN_LIMIT_EXCEEDED') {
        throw new BadRequestException('PIN_LIMIT_EXCEEDED');
      }
      throw e;
    }
    if (!result) throw new NotFoundException();
    return { id: result.id, isPinned: result.is_pinned };
  }

  async importKnowledge(userId: string, content: string) {
    const analysis = await this.systemChatService.analyzeImportContent(userId, content);
    const embedding = await this.modelService.embedText(content);
    const result = await this.memoryRepo.importKnowledgeMemory(userId, analysis, content, embedding);
    return this.getKnowledgeDetail(userId, result.id);
  }

  async exportKnowledgeById(userId: string, id: string): Promise<string | null> {
    const memory = await this.memoryRepo.findKnowledgeMemory(userId, id);
    return memory?.content ?? null;
  }

  async exportAllKnowledge(userId: string): Promise<string> {
    const memories = await this.memoryRepo.getKnowledgeList(userId);
    return memories.map(m => m.content ?? '').filter(Boolean).join('\n\n---\n\n');
  }

  private formatKnowledge(m: {
    id: string;
    keywords: { keyword_code: string; keyword: { name: string } }[];
    contents: { id: string; content: string }[];
    version: number;
    is_pinned: boolean;
    created_at: Date;
    summary: string | null;
  }) {
    return {
      id: m.id,
      keywords: m.keywords.map(mk => ({ code: mk.keyword_code, name: mk.keyword.name })),
      contents: m.contents.map(c => ({ id: c.id, content: c.content })),
      version: m.version,
      isPinned: m.is_pinned,
      createdAt: m.created_at,
      summary: m.summary,
    };
  }
}
