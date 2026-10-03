import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { MemoryRepository } from './memory.repository';
import { SystemChatService } from '../model/system-chat.service';

@Injectable()
export class MemoryService {
  constructor(
    private memoryRepo: MemoryRepository,
    private systemChatService: SystemChatService,
  ) {}

  async getActiveMainMemory(userId: string): Promise<string | null> {
    return this.memoryRepo.getActiveMainMemory(userId);
  }

  async getTopKnowledge(userId: string, embedding: number[], topN: number): Promise<{ id: string; summary: string }[]> {
    return this.memoryRepo.getTopKnowledge(userId, embedding, topN);
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
    return {
      contents: main?.contents.map(c => ({ id: c.id, content: c.content })) ?? [],
      updatedAt: main?.created_at ?? null,
    };
  }

  async updateMainMemory(userId: string, contents: string[]) {
    const existing = await this.memoryRepo.findMainMemory(userId);
    await this.memoryRepo.saveMainMemory(userId, contents, existing, 'modified');
    return this.getMainMemory(userId);
  }

  async updateKnowledge(userId: string, id: string, contents: { id?: string; text: string }[], summary: string) {
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

  async importKnowledge(userId: string, contents: string[]) {
    const analysis = await this.systemChatService.analyzeImportContent(userId, contents);
    const result = await this.memoryRepo.importKnowledgeMemory(userId, analysis);
    return this.getKnowledgeDetail(userId, result.id);
  }

  async exportKnowledgeById(userId: string, id: string): Promise<string | null> {
    const memory = await this.memoryRepo.findKnowledgeMemory(userId, id);
    if (!memory) return null;
    return memory.contents.map(c => c.content).join('\n');
  }

  async exportAllKnowledge(userId: string): Promise<string> {
    const memories = await this.memoryRepo.getKnowledgeList(userId);
    return memories
      .map(m => m.contents.map(c => c.content).join('\n'))
      .filter(Boolean)
      .join('\n\n---\n\n');
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
