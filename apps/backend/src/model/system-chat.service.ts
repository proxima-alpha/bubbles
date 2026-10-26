import {Injectable} from '@nestjs/common';
import {ModelService} from './model.service';
import {MemoryContentResult} from '../memory/memory.repository';
import {MessageForBatch} from '../message/message.repository';
import {Exchange} from "../memory/scheduler.service";

interface WeightedLabel {
  text: string;
  weight: number;
}

export interface MessageContentResult {
  summary: string;
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
    return `질문:\n${exchange.parent!.content}\n응답:\n${exchange.summary}`
  })
}

@Injectable()
export class SystemChatService {
  constructor(private modelService: ModelService) {
  }

  /**
   *   . 어시스턴트의 인사·자기소개·감사·맞장구·추임새 등 친교성 발화 전체를 제거한다.
   *   . 어시스턴트의 포부·의지 표현·대화 유도 등 의사 표명 발화를 제거한다.
   */

  private messageContentRule = `
[지침]
- 1-1 결과에 남은 발화가 없으면 summary 를 빈 값으로 출력하고 1-2와 2, 3은 수행하지 않는다.
- summary, domain, entity, action 의 언어는 [대화]의 주요 언어를 선호한다.
1. [대화]에서 정보를 추출한다.
1-1. [대화]에서 추출 대상이 아닌 발화를 제거한다.
  . 사실·설명·조언·방법·계획 등 내용이 담긴 발화만 남긴다.
1-2. 1-1의 결과에서 핵심 주제어와 핵심 관계만 남기고 간결하게 압축한다.
  . 같은 주제와 의미를 다루는 여러 문장은 핵심 내용만 남겨 하나의 정보 문장으로 통합한다.
  . 의미를 유지하는 범위에서 여러 표현을 하나의 일반화된 문장으로 정리하되, 원문에 없는 사실은 추가하지 않는다.
  . 전체 문장은 평서문으로 표현하고 제목·번호·불릿·라벨·Markdown 스타일 없이 추출한다.
  . 여러 도메인에서 다른 의미로 쓰일 수 있는 단어는 현재 문맥의 의미가 드러나도록 표현한다.
  . 메타정보(domain, entity, action) 를 미리 추출하지 않는다.
2. 1-2에서 정리한 정보 문장을 summary 에 그대로 작성한다.
3. summary 에서 주제를 식별하는 핵심 키워드를 메타정보(domain, entity, action) 에 배열로 추출한다.
  . summary 의 내용이 없으면 수행하지 않는다.
  . 추출할 정보가 없으면 각각 빈 배열을 반환한다.
  . 범용적인 단어로 표현하지 않는다.
  . domain: 문장이 속한 상위 분야 최대 1개
  . entity: 문장의 핵심 대상·개념 최대 3개
  . action: entity에 대해 수행되거나 설명되는 핵심 행위 최대 2개
`

  private messageContentSchema = {
    type: 'object',
    properties: {
      summary: {type: 'string'},
      // contents: {
      //   type: 'array',
      //   items: {
      //     type: 'object',
      //     additionalProperties: false,
      //     properties: {
      //       text: {type: 'string'},
      //       weight: {type: 'number'},
      //     },
      //     required: ['text', 'weight'],
      //   },
      // },
      domain: {type: 'array', items: {type: 'string'}},
      entity: {type: 'array', items: {type: 'string'}},
      action: {type: 'array', items: {type: 'string'}},
    },
    required: ['summary', 'domain', 'entity', 'action'],
  };

  async generateMessageContent(userId: string, questionContent: string, answerContent: string): Promise<MessageContentResult> {
    const systemPrompt = `[대화]를 아래 지시사항에 따라 분석하고 결과를 JSON으로 반환하라.${this.messageContentRule}`

    const dataText = `[대화]\n질문: \n${questionContent}\n응답: \n${answerContent}\n\n`

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, this.messageContentSchema);

    const {summary, contents, domain, entity, action} = JSON.parse(raw) as MessageContentResult;
    // if (contents.length == 0) {
    //   return {contents, domain: [], entity: [], action: []};
    // }
    return {summary, contents, domain, entity, action};
  }


  private memoryRule = `
[지침]
- 추출할 내용이 없으면 contents는 빈 배열을 반환한다.
- 장기 기억으로 남길 만한 정보란 특정 주제에 대한 설명·사실·방법에 관한 정보를 말한다.
- contents[i].text, contents[i].domain, contents[i].entity, contents[i].action, summary 는 반드시 [대화]에서 사용된 주요 언어와 동일한 언어로 작성한다.

1. 대화에서 장기 기억으로 남길 만한 정보를 재구성 한다.
  . 대화에 실제로 등장한 정보만 사용하고 새로운 사실을 만들지 않는다.
  . 여러 도메인에서 다른 의미로 쓰일 수 있는 단어는 현재 문맥의 의미가 드러나도록 표현한다.
  . 서로 다른 주제가 있을 때만 여러 문장으로 나눈다.
2. 추출한 정보를 contents에 할당한다.
2-1. contents[i].text 에 각 문장을 할당한다.
  . 한 개의 문장만 할당한다.
2-2. contents[i].text 에서 주제를 식별하는 핵심 키워드를 메타정보(domain, entity, action) 에 배열로 추출한다.
  . 키워드는 [대화]에 실제로 등장한 표현을 우선 사용한다.
  . domain: 문장이 속한 상위 분야 최대 1개
  . entity: 문장의 핵심 대상·개념 최대 3개
  . action: entity에 대해 수행되거나 설명되는 핵심 행위 최대 2개
2-3. 각 contents[i].text 문장마다 아래 점수를 0~1로 매긴다.
  . importance: 사용자 이해에 중요할수록 높음
  . durability: 시간이 지나도 유효할수록 높음 (날씨·일시적 감정 → 낮음, 직업·가치관·반복 패턴 → 높음)
  . reusefulness: 재활용 가능성이 높을수록 높음
  . sensitivity: 민감 정보일수록 높음
  . explicit_signal: 사용자가 확정적으로 말할수록 높음
  . llm_confidence_hint: 분석 신뢰도가 높을수록 높음
3. contents 전체를 한 문장으로 요약하여 summary에 담는다.
`

  private memorySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
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
            domain: {type: 'array', items: {type: 'string'}},
            entity: {type: 'array', items: {type: 'string'}},
            action: {type: 'array', items: {type: 'string'}},
          },
          required: [
            'text', 'importance', 'durability', 'reusefulness',
            'sensitivity', 'explicit_signal', 'llm_confidence_hint',
            'domain', 'entity', 'action'
          ],
        },
      },
      summary: {type: 'string'},
    },
    required: ['contents', 'summary'],
  }

  async generateMemoryContents(
    userId: string,
    exchanges: Exchange[],
  ): Promise<MemoryContentResult> {
    const inputArray = formatExchanges(exchanges);
    const systemPrompt = [
      `[대화] 내용을 [지침]에 따라 분석하여 JSON으로 응답하세요.`,
      this.memoryRule,
    ].join('\n');

    const dataText = `[대화]\n${JSON.stringify(inputArray, null, 2)}`;

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, this.memorySchema);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as MemoryContentResult;
  }

  async generateImportedMemoryContents(userId: string, contents: string[]): Promise<MemoryContentResult> {
    const systemPrompt = [
      `[정보] 목록을 [지침]에 따라 분석하여 JSON으로 응답하세요.`,
      this.memoryRule,
    ].join('\n');

    const dataText = `[정보]\n${JSON.stringify(contents, null, 2)}`;

    const raw = await this.modelService.chat(userId, [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: dataText},
    ], undefined, this.memorySchema);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as MemoryContentResult;
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
