import {Injectable} from '@nestjs/common';
import {ModelService} from './model.service';
import {LlmMemoryAnalysis} from '../memory/memory.repository';
import {MessageForBatch} from '../message/message.repository';
import {Exchange} from "../memory/scheduler.service";

interface WeightedLabel {
  text: string;
  weight: number;
}

function formatMessages(msgs: MessageForBatch[]) {
  return msgs.map(m => ({
    [m.role === 'user' ? 'user' : (m.provider ?? 'assistant')]: {
      text: m.content,
      message_id: m.role !== 'user' ? m.id : null,
    },
  }));
}

function normalizeWeights(contents: WeightedLabel[]): WeightedLabel[] {
  const sum = contents.reduce((acc, c) => acc + c.weight, 0);
  if (sum === 0) return contents;
  return contents.map(c => ({...c, weight: c.weight / sum}));
}

function formatExchanges(exchanges: Exchange[][]) {
  return exchanges.map(array => {
    const sorted = [...array].sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
    const merged = new Map<string, { role: string; content: string[] }>();
    for (const e of sorted) {
      const entry = merged.get(e.message_id) ?? {role: e.role, content: []};
      entry.content.push(e.content);
      merged.set(e.message_id, entry);
    }
    return Array.from(merged.values()).map(({role, content}) => {
      const title = role === 'user' ? '질문:' : '응답:';
      return `${title}\n${content.join(' ')}`;
    });
  })
}

@Injectable()
export class SystemChatService {
  constructor(private modelService: ModelService) {
  }

  private messageContentRule = `
[지침]
- contents[i].text는 대화에 등장한, 장기 기억으로 남길 만한 정보를 완결된 평서문으로 표현한 한 문장이다.
- contents는 빈 배열일 수 있다.
- 원문의 언어를 선호한다.
- 장기 기억으로 남길 만한 정보란 특정 주제에 대한 설명·사실·방법에 관한 정보를 말한다.
1. 대화에서 장기 기억으로 남길 만한 정보를 완결된 문장으로 추출한다.
    . 대화에 실제로 등장한 정보만 사용하고 새로운 사실을 만들지 않는다.
    . 각 문장은 구체적인 주제와 맥락이 드러나도록 서술한다.
    . 여러 도메인에서 다른 의미로 쓰일 수 있는 단어는 현재 문맥의 의미가 드러나게 표현한다.
    . 서로 다른 주제가 있을 때만 여러 문장으로 나눈다.
2. 각 문장이 전체 주제를 얼마나 대표하는지 weight를 0~1로 매긴다.
    . 대표 주제: 0.8~1.0
    . 보조 주제: 0.3 이상 0.8 미만
    . 그 외 주제: 0.0 이상 0.3 미만
`

  async generateMessageContent(userId: string, questionContent: string, answerContent: string): Promise<WeightedLabel[]> {
    const systemPrompt = `Analyze [Question] and [Response] according to the instructions below and return the result as JSON.${this.messageContentRule}`

    const dataText = `[Question]\n${questionContent}\n\n[Response]\n${answerContent}`

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, {
      type: 'object',
      properties: {
        contents: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: {type: 'string'},
              weight: {type: 'number'},
            },
            required: ['text', 'weight'],
          },
        },
      },
      required: ['contents'],
    });

    const {contents} = JSON.parse(raw) as { contents: { text: string; weight: number }[] };
    return contents;
  }

  async generateMessageContents(userId: string, exchanges: Exchange[][]): Promise<WeightedLabel[]> {
    const inputArray = formatExchanges(exchanges);

    const systemPrompt = `Analyze [Conversation] according to the instructions below and return the result as JSON.${this.messageContentRule}`

    const dataText = `[Conversation]\n${JSON.stringify(inputArray, null, 2)}`

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt,},
      {role: 'user', content: dataText},
    ], undefined, {
      type: 'object',
      properties: {
        contents: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: {type: 'string'},
              weight: {type: 'number'},
            },
            required: ['text', 'weight'],
          },
        },
      },
      required: ['contents'],
    });

    const {contents} = JSON.parse(raw) as { contents: { text: string; weight: number }[] };
    return contents;
  }

  async analyzeConversation(
    userId: string,
    exchanges: Exchange[][],
    existingContent?: string,
  ): Promise<LlmMemoryAnalysis> {
    const inputArray = formatExchanges(exchanges);
    const blocks: string[] = [
      `[대화] 내용을 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- 장기 기억으로 남길 만한 정보란 특정 주제에 대한 설명·사실·방법에 관한 정보를 말한다.
- 중요: contents[i].text, summary, keywords[i].name은 반드시 [대화]에서 사용된 주요 언어와 동일한 언어로 작성한다.
- contents[i].text는 [대화]에 등장한, 장기 기억으로 남길 만한 정보를 완결된 평서문으로 표현한 한 문장이다.
- contents 는 빈 배열일 수 있다.
- keywords[i].code: 영문 소문자·숫자·하이픈 으로 작성한다. (예: rag-technique)
- 아래에서 말하는 추출 결과는 contents[i].text 전체 문장의 조합을 말한다.`,
      `1. 대화에서 장기 기억으로 남길 만한 정보를 완결된 문장으로 추출하여 contents에 할당한다.
    . 대화에 실제로 등장한 정보만 사용하고 새로운 사실을 만들지 않는다.
    . 각 문장은 구체적인 주제와 맥락이 드러나도록 서술한다.
    . 여러 도메인에서 다른 의미로 쓰일 수 있는 단어는 현재 문맥의 의미가 드러나게 표현한다.
    . 서로 다른 주제가 있을 때만 여러 문장으로 나눈다.
2. 추출 결과에서 키워드를 추출하고, 각 keyword가 대화 전체를 얼마나 대표하는지 weight를 매긴다.
    . 대표 주제: 0.8~1.0
    . 보조 주제: 0.3 이상 0.8 미만
    . 그 외 주제: 0.0 이상 0.3 미만
3. 추출 결과에 대해 아래 점수를 0~1로 매긴다.
    . importance: 사용자 이해에 중요할수록 높음
    . durability: 시간이 지나도 유효할수록 높음
    . reusefulness: 재활용 가능성이 높을수록 높음
    . sensitivity: 민감 정보일수록 높음
    . explicit_signal: 사용자가 확정적으로 말할수록 높음
    . llm_confidence_hint: 분석 신뢰도가 높을수록 높음
    . temporary_penalty: 장기 기억 가치가 낮을수록 높음 (날씨·일시적 감정 → 높음, 직업·가치관 → 낮음)
4. 추출 결과를 한 문장으로 요약하여 summary에 담는다.`,
    ];
    if (existingContent) {
      blocks.push(`5. [기존 기억]을 최대한 유지하고, 대화에서 새롭게 확인된 정보만 추가한다.
    . 중복 내용은 추가하지 않는다.
    . 기존 기억과 명백히 충돌하거나 변경된 경우에만 수정한다.
    . 현재 대화와 관련이 없다는 이유로 기존 기억을 삭제하지 않는다.`);
    }
    const systemPrompt = blocks.join('\n\n');

    const dataTextBlocks: string[] = [];
    if (existingContent) dataTextBlocks.push(`[기존 기억]\n${existingContent}`);
    dataTextBlocks.push(`[대화]\n${JSON.stringify(inputArray, null, 2)}`);
    const dataText = dataTextBlocks.join('\n\n');

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
              code: {type: 'string'},
              name: {type: 'string'},
              weight: {type: 'number'},
            },
            required: ['code', 'name', 'weight'],
          },
        },
        contents: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        summary: {type: 'string'},
        importance: {type: 'number'},
        durability: {type: 'number'},
        reusefulness: {type: 'number'},
        sensitivity: {type: 'number'},
        explicit_signal: {type: 'number'},
        llm_confidence_hint: {type: 'number'},
        temporary_penalty: {type: 'number'},
      },
      required: [
        'keywords', 'contents', 'summary',
        'importance', 'durability', 'reusefulness', 'sensitivity',
        'explicit_signal', 'llm_confidence_hint', 'temporary_penalty',
      ]
    };
    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, schema);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as LlmMemoryAnalysis;
  }

  async analyzeImportContent(userId: string, contents: string[]): Promise<LlmMemoryAnalysis> {
    const blocks: string[] = [
      `[정보] 목록을 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- [정보]의 각 항목은 사용자가 직접 작성한 확정된 문장이다. 새로 만들거나 고쳐 쓰지 않는다.
- 중요: keywords[i].name, summary는 반드시 [정보]에서 사용된 주요 언어와 동일한 언어로 작성한다.
- keywords[i].code: 영문 소문자·숫자·하이픈 으로 작성한다. (예: rag-technique)`,
      `1. [정보] 전체에서 키워드를 추출하고, 각 keyword가 [정보] 전체를 얼마나 대표하는지 weight를 매긴다.
    . 대표 주제: 0.8~1.0
    . 보조 주제: 0.3 이상 0.8 미만
    . 그 외 주제: 0.0 이상 0.3 미만
2. [정보] 전체에 대해 아래 점수를 0~1로 매긴다.
    . importance: 사용자 이해에 중요할수록 높음
    . durability: 시간이 지나도 유효할수록 높음
    . reusefulness: 재활용 가능성이 높을수록 높음
    . sensitivity: 민감 정보일수록 높음
    . explicit_signal: 사용자가 확정적으로 말할수록 높음
    . llm_confidence_hint: 분석 신뢰도가 높을수록 높음
    . temporary_penalty: 장기 기억 가치가 낮을수록 높음 (날씨·일시적 감정 → 높음, 직업·가치관 → 낮음)
3. [정보] 전체를 한 문장으로 요약하여 summary에 담는다.`,
    ];
    const systemPrompt = blocks.join('\n\n');

    const dataText = `[정보]\n${JSON.stringify(contents, null, 2)}`;

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
              code: {type: 'string'},
              name: {type: 'string'},
              weight: {type: 'number'},
            },
            required: ['code', 'name', 'weight'],
          },
        },
        summary: {type: 'string'},
        importance: {type: 'number'},
        durability: {type: 'number'},
        reusefulness: {type: 'number'},
        sensitivity: {type: 'number'},
        explicit_signal: {type: 'number'},
        llm_confidence_hint: {type: 'number'},
        temporary_penalty: {type: 'number'},
      },
      required: [
        'keywords', 'summary',
        'importance', 'durability', 'reusefulness', 'sensitivity',
        'explicit_signal', 'llm_confidence_hint', 'temporary_penalty',
      ],
    };

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, schema);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    const parsed = JSON.parse(jsonMatch[0]) as Omit<LlmMemoryAnalysis, 'contents'>;
    return {...parsed, contents};
  }

  async synthesizeMainMemory(userId: string, existingSummary: string | null, newKnowledges: string[]): Promise<string[]> {
    if (existingSummary == null) {
      return newKnowledges
    }

    const systemPrompt = `[지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- 주요 언어를 바꾸지 않는다
- 분석 절차:
  1. [기존 기억] 과 [새로 추가된 지식]을 병합한다.
  2. [기존 기억]을 최대한 유지하고, 새롭게 확인된 핵심 정보만 추가한다.
    · 중복 내용은 추가하지 않는다.
    · 기존 기억과 명백히 충돌하거나 변경된 경우에만 수정한다.
    · 현재 대화와 관련이 없다는 이유로 기존 기억을 삭제하지 않는다.
  3. 병합한 내용을 문장 단위로 쪼개 각각 contents에 할당한다

- contents[i]: 추출·정제된 핵심 정보 한 문장`

    const dataText = `[기존 기억]\n${existingSummary}\n\n[새로 추가된 지식]\n${newKnowledges.join("\n")}`;

    // const prompt = existingSummary
    //   ? '다음은 사용자에 대해 알려진 정보입니다. [기존 기억]과 [새로 추가된 지식]을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.'
    //   : '다음은 사용자에 대해 알려진 정보입니다. [새로 추가된 지식]을 바탕으로 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.';
    // const dataText = existingSummary
    //   ? `[기존 기억]\n${existingSummary}\n\n[새로 추가된 지식]\n${newKnowledge}`
    //   : `[새로 추가된 지식]\n${newKnowledge}`;

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, {
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

    const {contents} = JSON.parse(raw) as { contents: string[] };
    return contents;
  }
}
