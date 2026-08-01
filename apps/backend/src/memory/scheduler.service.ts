import {Injectable} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '../prisma/prisma.service';
import {ModelService} from '../model/model.service';
import {
  BatchMemoryResult,
  Exchange,
  LlmMemoryAnalysis,
  MemoryRepository,
  MessageForBatch,
  SaveArgs
} from './memory.repository';

interface GroupArgs {
  messages: MessageForBatch[];
  memCentroid: number[];
  existingMemory: { id: string; version: number; root_memory_id: string | null; content: string | null } | null;
}

function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  return sum.map(x => x / vectors.length);
}


function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

@Injectable()
export class SchedulerService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private modelService: ModelService,
    private memoryRepo: MemoryRepository,
  ) {
  }

  @Cron('* * * * *')
  async checkAndRun() {
    const threshold = Number(this.config.get('SCHEDULER_MESSAGE_THRESHOLD', 5));
    const intervalHours = Number(this.config.get('SCHEDULER_BATCH_INTERVAL_HOURS', 24));

    const overThreshold = await this.memoryRepo.findUsersOverThreshold(threshold);
    const overInterval = await this.memoryRepo.findUsersOverInterval(intervalHours);

    const targetIds = [...new Set([...overThreshold, ...overInterval])];

    // for (const user_id of targetIds) {
    //   try {
    //     await this.executeMemorization(user_id);
    //     await this.prisma.schedule.upsert({
    //       where: { user_id_type: { user_id, type: 'memory_batch' } },
    //       update: { updated_at: new Date() },
    //       create: { user_id, type: 'memory_batch' },
    //     });
    //   } catch (e) {
    //     console.error(`batch failed for user ${user_id}`, e);
    //   }
    // }
    // updateMainMemory는 독립된 스케줄러로 분리 필요(todo.md 참고) — 여기서 순차 호출하지 않음
  }

  async executeMemorization(userId: string): Promise<BatchMemoryResult[]> {
    const exchanges = await this.memoryRepo.findUnprocessedExchanges(userId);
    if (exchanges.length === 0) return [];

    const rawGroups: GroupArgs[] = [];

    if (exchanges.length <= 1) {
      for (const exchange of exchanges) {
        rawGroups.push(await this.prepareGroup(userId, [exchange]));
      }
    } else {
      const exchangeTexts = exchanges.map(e => e.messages.map(m => m.content).join('\n'));
      const vectors = await this.modelService.embedTextsChunked(exchangeTexts, 'clustering: ');
      const ids = exchanges.map(e => e.id);

      const clusterResult = await this.runClustering(vectors, ids);
      const exchangeMap = new Map(exchanges.map(e => [e.id, e]));

      const clusterGroups = await Promise.all(
        clusterResult.clusters.map((cluster: { label: number; ids: string[] }) =>
          this.prepareGroup(userId, cluster.ids.map((id: string) => exchangeMap.get(id)!)),
        ),
      );
      for (const g of clusterGroups) rawGroups.push(g);

      for (const noiseId of clusterResult.noise) {
        rawGroups.push(await this.prepareGroup(userId, [exchangeMap.get(noiseId)!]));
      }
    }

    const groups = this.consolidateByTarget(rawGroups);

    const pendingSaves: SaveArgs[] = [];
    for (const group of groups) {
      const existingMessages = group.existingMemory
        ? await this.memoryRepo.findMemoryMessages(group.existingMemory.root_memory_id ?? group.existingMemory.id)
        : undefined;
      const analysis = await this.callLlmForAnalysis(userId, group.messages, group.existingMemory?.content ?? undefined);
      if (analysis.contents.length > 0) {
        const associationMessages = existingMessages ? [...existingMessages, ...group.messages] : group.messages;
        const associations = await this.runAssociationMapping(analysis.contents, associationMessages);
        pendingSaves.push({...group, analysis: {...analysis, associations}});
      }
    }

    const allContentEmbeddings = exchanges.flatMap(e => e.contentEmbeddings);
    return this.prisma.$transaction(async (tx) => {
      const batchResults: BatchMemoryResult[] = [];
      for (const args of pendingSaves) {
        batchResults.push(await this.memoryRepo.saveMemory(tx, userId, args));
      }
      await this.memoryRepo.updateRepetitionStrength(tx, userId, allContentEmbeddings, batchResults.map(r => r.id));
      return batchResults;
    });
  }

  private consolidateByTarget(groups: GroupArgs[]): GroupArgs[] {
    const byTarget = new Map<string, GroupArgs[]>();
    const noTarget: GroupArgs[] = [];

    for (const group of groups) {
      if (!group.existingMemory) {
        noTarget.push(group);
      } else {
        const key = group.existingMemory.id;
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key)!.push(group);
      }
    }

    const merged: GroupArgs[] = [...noTarget];
    for (const sameTarget of byTarget.values()) {
      merged.push({
        messages: sameTarget.flatMap(g => g.messages),
        memCentroid: centroid(sameTarget.map(g => g.memCentroid)),
        existingMemory: sameTarget[0].existingMemory,
      });
    }
    return merged;
  }

  private async prepareGroup(userId: string, exchanges: Exchange[]): Promise<GroupArgs> {
    const mergeMaxSimilarity = Number(this.config.get('MERGE_MAX_SIMILARITY', 0.8));
    const mergeAvgSimilarity = Number(this.config.get('MERGE_AVG_SIMILARITY', 0.7));

    const allContentEmbeddings = exchanges.flatMap(e => e.contentEmbeddings);
    const clusterCentroid = centroid(allContentEmbeddings);

    const avgSimilarity =
      allContentEmbeddings.reduce((acc, v) => acc + cosineSimilarity(v, clusterCentroid), 0) /
      allContentEmbeddings.length;

    const existingMemory = await this.memoryRepo.findSimilarMemory(userId, clusterCentroid, mergeMaxSimilarity);
    let isMerge = existingMemory !== null && avgSimilarity >= mergeAvgSimilarity;
    if (isMerge) {
      const existingMessages = await this.memoryRepo.findMemoryMessages(
        existingMemory!.root_memory_id ?? existingMemory!.id,
      );
      if (existingMessages.length === 0) isMerge = false;
    }

    return {
      messages: exchanges.flatMap(e => e.messages),
      memCentroid: clusterCentroid,
      existingMemory: isMerge ? existingMemory : null,
    };
  }

  private async callLlmForAnalysis(
    userId: string,
    messages: MessageForBatch[],
    existingContent?: string,
  ): Promise<LlmMemoryAnalysis> {
    const formatMessages = (msgs: MessageForBatch[]) =>
      msgs.map(m => ({
        [m.role === 'user' ? 'user' : (m.provider ?? 'assistant')]: {
          text: m.content,
          message_id: m.role !== 'user' ? m.id : null,
        },
      }));

    const inputArray = formatMessages(messages);
    const existingSection = existingContent ? `[기존 기억]\n${existingContent}\n\n` : '';

    const prompt = `[대화] 내용을 [지침]에 따라 분석하여 JSON으로 응답하세요.
[지침]
-주요 언어를 바꾸지 않는다
- 분석 절차:
  1. 응답에서 장기 기억으로 남길 핵심 정보를 짧은 문장들의 문어체로 추출한다
    · 기억할 가치가 있는 정보가 없으면 contents와 keywords 빈 배열([])로 둔다.
    . 인사·감사·맞장구 등 정보가 없는 대화는 아무것도 추출하지 않는다.
    . 같은 개념의 단어가 한국어와 영어로 모두 표기된 경우 한국어를 사용한다.
    . 한국어 표현이 없는 단어는 영어를 사용한다.
  2. 추출한 핵심 정보를 문장 단위로 쪼개 각각 contents에 할당한다
  3. 추출한 정보 중 keywords를 뽑는다
  4. [기존 기억]이 있으면 이를 최대한 유지하고, 대화에서 새롭게 확인된 핵심 정보만 추가한다.
     · 중복 내용은 추가하지 않는다.
     · 기존 기억과 명백히 충돌하거나 변경된 경우에만 수정한다.
     · 현재 대화와 관련이 없다는 이유로 기존 기억을 삭제하지 않는다.
- contents[i]: 추출·정제된 핵심 정보 한 문장
- keywords: 최종 완성된 contents의 핵심 주제. contents 전체를 관통하는 중심 개념만.
    · 부차적으로 언급된 세부 기법·예시는 키워드로 만들지 않는다
- keywords[i].code: 영문 소문자·숫자·하이픈 (예: rag-technique)
- keywords[i].name: 키워드명, 한글 선호, 괄호 등 부가설명 하지않음
- summary: contents 전체의 짧은 요약
- 점수(0~1): importance(사용자 이해에 중요할수록 높음), durability(시간이 지나도 유효할수록 높음), reusefulness(재활용 가능성), sensitivity(민감정보일수록 높음), explicit_signal(사용자가 확정적으로 말할수록 높음), llm_confidence_hint(분석 신뢰도), temporary_penalty(장기 기억 가치가 낮을수록 높음 — 날씨·일시적 감정 → 높음, 직업·가치관 → 낮음)

${existingSection}[대화]\n${JSON.stringify(inputArray, null, 2)}`;

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
    const fullContent = await this.modelService.chat(userId, [{
      role: 'user',
      content: prompt
    }], {num_predict: 1024}, schema);

    const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as LlmMemoryAnalysis;
  }

  private async runAssociationMapping(
    contents: string[],
    messages: MessageForBatch[],
  ): Promise<string[][]> {
    const assistantMessages = messages.filter(m => m.role !== 'user');
    if (assistantMessages.length === 0) return contents.map(() => []);

    const contentEmbeddings = await this.modelService.embedTextsChunked(contents, 'search_query: ');
    // console.log(contents)
    // await this.memoryRepo.logAssociations(contentEmbeddings, assistantMessages.map(m => m.id))
    return this.memoryRepo.findAssociations(contentEmbeddings, assistantMessages.map(m => m.id));
  }

  private async runClustering(vectors: number[][], ids: string[]) {
    const url = this.config.get<string>('CLUSTERING_URL', 'http://clustering:8000');
    const minClusterSize = Number(this.config.get('CLUSTERING_MIN_CLUSTER_SIZE', 2));
    const similarityThreshold = Number(this.config.get('CLUSTERING_SIMILARITY_THRESHOLD', 0.95));
    const res = await fetch(`${url}/cluster`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({vectors, ids, min_cluster_size: minClusterSize, similarity_threshold: similarityThreshold}),
    });
    if (!res.ok) throw new Error(`Clustering error: ${res.status}`);
    return res.json();
  }

  async updateMainMemory(userId: string) {
    const scoreThreshold = Number(this.config.get('PROMOTION_SCORE_THRESHOLD', 0.75));
    const sensitivityThreshold = Number(this.config.get('PROMOTION_SENSITIVITY_THRESHOLD', 0.3));

    const promoted = await this.memoryRepo.findPromotedMemories(userId, scoreThreshold, sensitivityThreshold);
    if (promoted.length === 0) return;

    const existing = await this.memoryRepo.findMainMemory(userId);

    const newKnowledge = promoted.map(m => m.summary ?? '').filter(Boolean).join('\n---\n');

    const promptText = existing
      ? `다음은 사용자에 대해 알려진 정보입니다.\n\n[기존 기억]\n${existing.summary ?? ''}\n\n[새로 추가된 지식]\n${newKnowledge}\n\n위 내용을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.`
      : `다음은 사용자에 대해 알려진 정보입니다.\n\n[새로 추가된 지식]\n${newKnowledge}\n\n위 내용을 바탕으로 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.`;

    const mainSummary = await this.modelService.chat(userId, [{role: 'user', content: promptText}]);

    await this.memoryRepo.saveMainMemory(userId, mainSummary, existing);
  }
}
