import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { MemoryRepository } from './memory.repository';

@Injectable()
export class MemoryService {
  constructor(private memoryRepo: MemoryRepository) {}

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
