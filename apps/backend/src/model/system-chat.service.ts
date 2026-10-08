import {Injectable} from '@nestjs/common';
import {ModelService} from './model.service';
import {LlmContentScore, LlmMemoryAnalysis} from '../memory/memory.repository';
import {MessageForBatch} from '../message/message.repository';
import {Exchange} from "../memory/scheduler.service";

interface WeightedLabel {
  text: string;
  weight: number;
}

export interface MessageContentResult {
  contents: WeightedLabel[];
  domain: string[];
  entity: string[];
  action: string[];
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

function formatExchanges(exchanges: Exchange[]) {
  return exchanges.map(exchange => {
    return `질문:\n${exchange.parent!.content}\n응답:\n${exchange.content}`
  })
}

@Injectable()
export class SystemChatService {
  constructor(private modelService: ModelService) {
  }

  private messageContentRule = `
[지침]
- 추출할 내용이 없으면 contents는 빈 배열을 반환한다.
- contents[i].text, domain, entity, action의 언어는 [대화]의 주요 언어를 선호한다.
1. [대화]에서 정보를 추출한다.
    . 특정 주제에 대한 설명·사실·방법 중, 이후 대화에서도 다시 활용할 가치가 있는 정보를 추출한다.
    . 대화에 실제로 등장한 정보만 사용하고 새로운 사실을 만들지 않는다.
    . 각 문장은 완결된 평서문 한 문장으로 표현한다.
    . 여러 도메인에서 다른 의미로 쓰일 수 있는 단어는 현재 문맥의 의미가 드러나도록 표현한다.
    . 기억할 정보가 없는 인사, 자기소개, 포부, 맞장구, 추임새, 제안, 추측으로 이루어진 문장은 추출 대상이 아니다.
2. 추출한 정보를 contents에 할당한다.
    . contents[i].text에 각 문장을 할당한다. 한 번에 한 개의 문장만 할당한다.
    . contents[i].weight는 각 문장이 추출한 정보에 대해 주제를 얼마나 대표하는지 0~1로 평가한다.
    . 메타정보(domain, entity, action)는 contents 에 포함시키지 않는다.
    . 대표 주제: 0.8 이상 1.0 이하
    . 보조 주제: 0.3 이상 0.8 미만
    . 그 외 주제: 0.0 이상 0.3 미만
3. 추출한 정보에서 주제를 식별하는 핵심 키워드를 메타정보(domain, entity, action) 에 배열로 추출한다.
    . 키워드는 [대화]에 실제로 등장한 표현을 우선 사용한다.
    . domain: 문장이 속한 상위 분야 1~2개
    . entity: 문장의 핵심 대상·개념 1~5개
    . action: entity에 대해 수행되거나 설명되는 핵심 행위 0~3개
`

  private messageContentSchema = {
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
      domain: {type: 'array', items: {type: 'string'}},
      entity: {type: 'array', items: {type: 'string'}},
      action: {type: 'array', items: {type: 'string'}},
    },
    required: ['contents', 'domain', 'entity', 'action'],
  };

  async generateMessageContent(userId: string, questionContent: string, answerContent: string): Promise<MessageContentResult> {
    const systemPrompt = `[대화]를 아래 지시사항에 따라 분석하고 결과를 JSON으로 반환하라.${this.messageContentRule}`

    const dataText = `[대화]\n질문: \n${questionContent}\n응답: \n${answerContent}\n\n`

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, this.messageContentSchema);

    const {contents, domain, entity, action} = JSON.parse(raw) as MessageContentResult;
    if (contents.length == 0) {
      return {contents, domain: [], entity: [], action: []};
    }
    return {contents, domain, entity, action};
  }

  async analyzeConversation(
    userId: string,
    exchanges: Exchange[],
  ): Promise<LlmMemoryAnalysis> {
    const inputArray = formatExchanges(exchanges);
    const systemPrompt = [
      `[대화] 내용을 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- 장기 기억으로 남길 만한 정보란 특정 주제에 대한 설명·사실·방법에 관한 정보를 말한다.
- 중요: contents[i].text, summary, keywords[i].name은 반드시 [대화]에서 사용된 주요 언어와 동일한 언어로 작성한다.
- contents[i].text는 [대화]에 등장한, 장기 기억으로 남길 만한 정보를 완결된 평서문으로 표현한 한 문장이다.
- keywords[i].code: 영문 소문자·숫자·하이픈 으로 작성한다. (예: rag-technique)
- 추출할 정보가 없으면 반드시 contents는 빈 배열을 반환한다.`,
      `1. 대화에서 장기 기억으로 남길 만한 정보를 완결된 문장으로 추출하여 contents[i].text에 할당한다.
    . 대화에 실제로 등장한 정보만 사용하고 새로운 사실을 만들지 않는다.
    . 각 문장은 구체적인 주제와 맥락이 드러나도록 서술한다.
    . 여러 도메인에서 다른 의미로 쓰일 수 있는 단어는 현재 문맥의 의미가 드러나게 표현한다.
    . 서로 다른 주제가 있을 때만 여러 문장으로 나눈다.
2. contents 전체에서 키워드를 추출하고, 각 keyword가 대화 전체를 얼마나 대표하는지 weight를 매긴다.
    . 대표 주제: 0.8~1.0
    . 보조 주제: 0.3 이상 0.8 미만
    . 그 외 주제: 0.0 이상 0.3 미만
3. 각 contents 문장마다 아래 점수를 0~1로 매긴다.
    . importance: 사용자 이해에 중요할수록 높음
    . durability: 시간이 지나도 유효할수록 높음 (날씨·일시적 감정 → 낮음, 직업·가치관·반복 패턴 → 높음)
    . reusefulness: 재활용 가능성이 높을수록 높음
    . sensitivity: 민감 정보일수록 높음
    . explicit_signal: 사용자가 확정적으로 말할수록 높음
    . llm_confidence_hint: 분석 신뢰도가 높을수록 높음
4. contents 전체를 한 문장으로 요약하여 summary에 담는다.`,
    ].join('\n\n');

    const dataText = `[대화]\n${JSON.stringify(inputArray, null, 2)}`;

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
            type: 'object',
            additionalProperties: false,
            properties: {
              text: {type: 'string'},
              importance: {type: 'number'},
              durability: {type: 'number'},
              reusefulness: {type: 'number'},
              sensitivity: {type: 'number'},
              explicit_signal: {type: 'number'},
              llm_confidence_hint: {type: 'number'},
            },
            required: [
              'text', 'importance', 'durability', 'reusefulness',
              'sensitivity', 'explicit_signal', 'llm_confidence_hint',
            ],
          },
        },
        summary: {type: 'string'},
      },
      required: ['keywords', 'contents', 'summary'],
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
    const systemPrompt = [
      `[정보] 목록을 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
- [정보]의 각 항목은 사용자가 직접 작성한 확정된 문장이다. 새로 만들거나 고쳐 쓰지 않는다.
- scores는 [정보]와 같은 길이의 배열이며, scores[i]는 [정보][i]에 대한 점수다.
- 중요: keywords[i].name, summary는 반드시 [정보]에서 사용된 주요 언어와 동일한 언어로 작성한다.
- keywords[i].code: 영문 소문자·숫자·하이픈 으로 작성한다. (예: rag-technique)`,
      `1. [정보] 전체에서 키워드를 추출하고, 각 keyword가 [정보] 전체를 얼마나 대표하는지 weight를 매긴다.
    . 대표 주제: 0.8~1.0
    . 보조 주제: 0.3 이상 0.8 미만
    . 그 외 주제: 0.0 이상 0.3 미만
2. [정보]의 각 항목마다 scores[i]에 아래 점수를 0~1로 매긴다.
    . importance: 사용자 이해에 중요할수록 높음
    . durability: 시간이 지나도 유효할수록 높음 (날씨·일시적 감정 → 낮음, 직업·가치관·반복 패턴 → 높음)
    . reusefulness: 재활용 가능성이 높을수록 높음
    . sensitivity: 민감 정보일수록 높음
    . explicit_signal: 사용자가 확정적으로 말할수록 높음
    . llm_confidence_hint: 분석 신뢰도가 높을수록 높음
3. [정보] 전체를 한 문장으로 요약하여 summary에 담는다.`,
    ].join('\n\n');

    const dataText = `[정보]\n${JSON.stringify(contents, null, 2)}`;

    const scoreSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        importance: {type: 'number'},
        durability: {type: 'number'},
        reusefulness: {type: 'number'},
        sensitivity: {type: 'number'},
        explicit_signal: {type: 'number'},
        llm_confidence_hint: {type: 'number'},
      },
      required: ['importance', 'durability', 'reusefulness', 'sensitivity', 'explicit_signal', 'llm_confidence_hint'],
    };
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
        scores: {type: 'array', items: scoreSchema},
        summary: {type: 'string'},
      },
      required: ['keywords', 'scores', 'summary'],
    };

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, schema);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    const parsed = JSON.parse(jsonMatch[0]) as {
      keywords: LlmMemoryAnalysis['keywords'];
      scores: Omit<LlmContentScore, 'text'>[];
      summary: string;
    };
    return {
      keywords: parsed.keywords,
      summary: parsed.summary,
      contents: contents.map((text, i) => ({text, ...parsed.scores[i]})),
    };
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
