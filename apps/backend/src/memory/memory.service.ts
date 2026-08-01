import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { MemoryRepository, LlmMemoryAnalysis } from './memory.repository';
import { ModelService } from '../model/model.service';

@Injectable()
export class MemoryService {
  constructor(
    private memoryRepo: MemoryRepository,
    private modelService: ModelService,
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
    const analysis = await this.callLlmForImport(userId, content);
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

  private async callLlmForImport(userId: string, content: string): Promise<LlmMemoryAnalysis> {
    const prompt = `다음 [문서]를 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- 주요 언어를 바꾸지 않는다
- 문서에서 장기 기억으로 남길 핵심 정보를 짧은 문장들의 문어체로 추출해 contents에 문장 단위로 할당한다
- 추출한 정보 중 keywords를 뽑는다
- contents[i]: 추출·정제된 핵심 정보 한 문장
- keywords: 최종 완성된 contents의 핵심 주제. contents 전체를 관통하는 중심 개념만.
- keywords[i].code: 영문 소문자·숫자·하이픈 (예: rag-technique)
- keywords[i].name: 키워드명, 한글 선호, 괄호 등 부가설명 하지않음
- summary: contents 전체의 짧은 요약
- 점수(0~1): importance(사용자 이해에 중요할수록 높음), durability(시간이 지나도 유효할수록 높음), reusefulness(재활용 가능성), sensitivity(민감정보일수록 높음), explicit_signal(사용자가 확정적으로 말할수록 높음), llm_confidence_hint(분석 신뢰도), temporary_penalty(장기 기억 가치가 낮을수록 높음)

[문서]
${content}`;

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        keywords: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['code', 'name'],
          },
        },
        contents: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        importance: { type: 'number' },
        durability: { type: 'number' },
        reusefulness: { type: 'number' },
        sensitivity: { type: 'number' },
        explicit_signal: { type: 'number' },
        llm_confidence_hint: { type: 'number' },
        temporary_penalty: { type: 'number' },
      },
      required: [
        'keywords', 'contents', 'summary',
        'importance', 'durability', 'reusefulness', 'sensitivity',
        'explicit_signal', 'llm_confidence_hint', 'temporary_penalty',
      ],
    };

    const fullContent = await this.modelService.chat(userId, [{ role: 'user', content: prompt }], { num_predict: 1024 }, schema);
    const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as LlmMemoryAnalysis;
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
