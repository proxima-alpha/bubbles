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
    return array.map(e => {
      const title = e.role === 'user' ? '[질문]' : '[응답]'
      return `${title}\n${e.content}`
    })
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
    const systemPrompt = `[대화] 내용을 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- contents[i].text는 대화에 등장한, 장기 기억으로 남길 만한 정보를 완결된 평서문으로 표현한 한 문장이다.
- 장기 기억으로 남길 만한 정보란 특정 주제에 대한 설명·사실·방법에 관한 정보를 말한다.
- contents는 빈 배열일 수 있다.
- 원문의 언어를 선호한다.
- 같은 개념이 한국어와 영어로 모두 표기된 경우 한국어를 사용하고, 한국어 표현이 없는 단어는 영어를 사용한다.

1. 대화에서 장기 기억으로 남길 만한 정보를 완결된 문장으로 추출하여 contents에 할당한다.
    . 대화에 실제로 등장한 정보만 사용하고 새로운 사실을 만들지 않는다.
    . 각 문장은 구체적인 주제와 맥락이 드러나도록 서술한다.
    . 여러 도메인에서 다른 의미로 쓰일 수 있는 단어는 현재 문맥의 의미가 드러나게 표현한다.
    . 서로 다른 주제가 있을 때만 여러 문장으로 나눈다.
2. 각 contents[i]에 대해 아래 점수를 0~1로 매긴다.
    . importance: 사용자 이해에 중요할수록 높음
    . durability: 시간이 지나도 유효할수록 높음
    . reusefulness: 재활용 가능성이 높을수록 높음
    . sensitivity: 민감 정보일수록 높음
    . explicit_signal: 사용자가 확정적으로 말할수록 높음
    . llm_confidence_hint: 분석 신뢰도가 높을수록 높음
    . temporary_penalty: 장기 기억 가치가 낮을수록 높음 (날씨·일시적 감정 → 높음, 직업·가치관 → 낮음)
3. 최종 완성된 contents에서 전체를 관통하는 중심 개념만 keywords로 뽑는다.
    . 부차적으로 언급된 세부 기법·예시는 keywords로 만들지 않는다.
4. contents 전체를 한 문장으로 요약하여 summary에 담는다.
${existingContent ? `5. [기존 기억]을 최대한 유지하고, 대화에서 새롭게 확인된 정보만 추가한다.
    . 중복 내용은 추가하지 않는다.
    . 기존 기억과 명백히 충돌하거나 변경된 경우에만 수정한다.
    . 현재 대화와 관련이 없다는 이유로 기존 기억을 삭제하지 않는다.
` : ``}
- keywords[i].code: 영문 소문자·숫자·하이픈 (예: rag-technique)
- keywords[i].name: 키워드명, 한글 선호, 괄호 등 부가 설명은 하지 않는다.
`

    const dataText = `${existingContent ? `[기존 기억]\n${existingContent}\n\n` : ''}[대화]\n${JSON.stringify(inputArray, null, 2)}`;

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
            },
            required: ['code', 'name'],
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

  async analyzeImportContent(userId: string, content: string): Promise<LlmMemoryAnalysis> {
    const systemPrompt = `다음 [문서]를 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- 주요 언어를 바꾸지 않는다
- 문서에서 장기 기억으로 남길 핵심 정보를 짧은 문장들의 문어체로 추출해 contents에 문장 단위로 할당한다
- 추출한 정보 중 keywords를 뽑는다
- contents[i]: 추출·정제된 핵심 정보 한 문장
- keywords: 최종 완성된 contents의 핵심 주제. contents 전체를 관통하는 중심 개념만.
- keywords[i].code: 영문 소문자·숫자·하이픈 (예: rag-technique)
- keywords[i].name: 키워드명, 한글 선호, 괄호 등 부가설명 하지않음
- summary: contents 전체의 요약 한 문장
- 점수(0~1): importance(사용자 이해에 중요할수록 높음), durability(시간이 지나도 유효할수록 높음), reusefulness(재활용 가능성), sensitivity(민감정보일수록 높음), explicit_signal(사용자가 확정적으로 말할수록 높음), llm_confidence_hint(분석 신뢰도), temporary_penalty(장기 기억 가치가 낮을수록 높음)
`;

    const dataText = `[문서]\n${content}`;

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
            },
            required: ['code', 'name'],
          },
        },
        contents: {type: 'array', items: {type: 'string'}},
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
      ],
    };

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, schema);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as LlmMemoryAnalysis;
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
