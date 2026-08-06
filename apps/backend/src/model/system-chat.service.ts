import { Injectable } from '@nestjs/common';
import { ModelService } from './model.service';
import { LlmMemoryAnalysis, MessageForBatch } from '../memory/memory.repository';

@Injectable()
export class SystemChatService {
  constructor(private modelService: ModelService) {}

  async generateMessageContents(userId: string, questionContent: string, answerContent: string): Promise<string[]> {
    const raw = await this.modelService.chat(userId, [
      { role: 'system', content: `[질문]과 [응답]을 보고 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
-주요 언어를 바꾸지 않는다 (질문 한 언어 선호)
- 분석 절차:
  1. [질문] 및 [응답]의 요약을 짧은 문장들의 문어체로 추출한다
    · 기억할 가치가 있는 정보가 없으면 contents를 빈 배열([])로 둔다.
    . 인사·감사·맞장구 등 정보가 없는 대화는 아무것도 추출하지 않는다.
    . 같은 개념의 단어가 한국어와 영어로 모두 표기된 경우 한국어를 사용한다.
    . 한국어 표현이 없는 단어는 영어를 사용한다.
  2. 추출한 요약을 문장 단위로 쪼개 각각 contents에 할당한다

- contents[i]: 추출·정제된 핵심 정보 한 문장` },
      { role: 'user', content: `[질문]\n${questionContent}\n\n[응답]\n${answerContent}` },
    ], { num_predict: 150 }, {
      type: 'object',
      properties: {
        contents: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['contents'],
    });

    const { contents } = JSON.parse(raw) as { contents: string[] };
    return contents;
  }

  async summarizeForClustering(userId: string, messages: MessageForBatch[]): Promise<string> {
    return this.modelService.chat(userId, [
      { role: 'system', content: '다음 대화 내용을 한두 문장으로 요약하세요.' },
      { role: 'user', content: messages.map(m => m.content).join('\n') },
    ], { num_predict: 150 });
  }

  async synthesizeMainMemory(userId: string, existingSummary: string | null, newKnowledge: string): Promise<string> {
    const instruction = existingSummary
      ? '다음은 사용자에 대해 알려진 정보입니다. [기존 기억]과 [새로 추가된 지식]을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.'
      : '다음은 사용자에 대해 알려진 정보입니다. [새로 추가된 지식]을 바탕으로 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.';
    const dataText = existingSummary
      ? `[기존 기억]\n${existingSummary}\n\n[새로 추가된 지식]\n${newKnowledge}`
      : `[새로 추가된 지식]\n${newKnowledge}`;

    return this.modelService.chat(userId, [
      { role: 'system', content: instruction },
      { role: 'user', content: dataText },
    ]);
  }

  async analyzeImportContent(userId: string, content: string): Promise<LlmMemoryAnalysis> {
    const instruction = `다음 [문서]를 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- 주요 언어를 바꾸지 않는다
- 문서에서 장기 기억으로 남길 핵심 정보를 짧은 문장들의 문어체로 추출해 contents에 문장 단위로 할당한다
- 추출한 정보 중 keywords를 뽑는다
- contents[i]: 추출·정제된 핵심 정보 한 문장
- keywords: 최종 완성된 contents의 핵심 주제. contents 전체를 관통하는 중심 개념만.
- keywords[i].code: 영문 소문자·숫자·하이픈 (예: rag-technique)
- keywords[i].name: 키워드명, 한글 선호, 괄호 등 부가설명 하지않음
- summary: contents 전체의 짧은 요약
- 점수(0~1): importance(사용자 이해에 중요할수록 높음), durability(시간이 지나도 유효할수록 높음), reusefulness(재활용 가능성), sensitivity(민감정보일수록 높음), explicit_signal(사용자가 확정적으로 말할수록 높음), llm_confidence_hint(분석 신뢰도), temporary_penalty(장기 기억 가치가 낮을수록 높음)`;

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

    const fullContent = await this.modelService.chat(userId, [
      { role: 'system', content: instruction },
      { role: 'user', content: `[문서]\n${content}` },
    ], { num_predict: 1024 }, schema);
    const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as LlmMemoryAnalysis;
  }
}
