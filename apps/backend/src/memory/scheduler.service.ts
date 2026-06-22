import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ModelService } from '../model/model.service';
import { MemoryRepository, BatchMemoryResult, LlmMemoryAnalysis, MessageForBatch, Exchange, SaveArgs } from './memory.repository';

interface GroupArgs {
  messages: MessageForBatch[];
  memCentroid: number[];
  existingMemory: { id: string; content: string | null; version: number; root_memory_id: string | null } | null;
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
  ) {}

  @Cron('* * * * *')
  async checkAndRun() {
    const threshold = this.config.get<number>('SCHEDULER_MESSAGE_THRESHOLD', 5);
    const intervalHours = this.config.get<number>('SCHEDULER_BATCH_INTERVAL_HOURS', 24);

    const overThreshold = await this.memoryRepo.findUsersOverThreshold(threshold);
    const overInterval = await this.memoryRepo.findUsersOverInterval(intervalHours);

    const targetIds = [...new Set([...overThreshold, ...overInterval])];

    // for (const user_id of targetIds) {
    //   try {
    //     const batchResults = await this.runBatch(user_id);
    //     await this.updateMainMemory(user_id, batchResults);
    //     await this.prisma.schedule.upsert({
    //       where: { user_id_type: { user_id, type: 'memory_batch' } },
    //       update: { updated_at: new Date() },
    //       create: { user_id, type: 'memory_batch' },
    //     });
    //   } catch (e) {
    //     console.error(`batch failed for user ${user_id}`, e);
    //   }
    // }
  }

  async runBatch(userId: string): Promise<BatchMemoryResult[]> {
    const minClusterSize = this.config.get<number>('CLUSTERING_MIN_CLUSTER_SIZE', 2);

    const exchanges = await this.memoryRepo.findUnprocessedExchanges(userId);
    if (exchanges.length === 0) return [];

    const groups: GroupArgs[] = [];

    if (exchanges.length < minClusterSize) {
      for (const exchange of exchanges) {
        groups.push(await this.prepareGroup(userId, [exchange]));
      }
    } else {
      const vectors = exchanges.map(e => e.embedding);
      const ids = exchanges.map(e => e.id);

      const clusterResult = await this.runClustering(vectors, ids);
      const exchangeMap = new Map(exchanges.map(e => [e.id, e]));

      const clusterGroups = await Promise.all(
        clusterResult.clusters.map((cluster: { label: number; ids: string[] }) =>
          this.prepareGroup(userId, cluster.ids.map((id: string) => exchangeMap.get(id)!)),
        ),
      );
      for (const g of clusterGroups) groups.push(g);

      for (const noiseId of clusterResult.noise) {
        groups.push(await this.prepareGroup(userId, [exchangeMap.get(noiseId)!]));
      }
    }

    const pendingSaves: SaveArgs[] = [];
    for (const group of groups) {
      const analysis = await this.callLlmForAnalysis(userId, group.messages, group.existingMemory?.content);
      pendingSaves.push({ ...group, analysis });
    }

    const allMessages = exchanges.flatMap(e => e.messages);
    return this.prisma.$transaction(async (tx) => {
      const batchResults: BatchMemoryResult[] = [];
      for (const args of pendingSaves) {
        batchResults.push(await this.memoryRepo.saveMemory(tx, userId, args));
      }
      await this.memoryRepo.updateRepetitionStrength(tx, userId, allMessages, batchResults.map(r => r.id));
      return batchResults;
    });
  }

  private async prepareGroup(userId: string, exchanges: Exchange[]): Promise<GroupArgs> {
    const mergeMaxSimilarity = this.config.get<number>('MERGE_MAX_SIMILARITY', 0.8);
    const mergeAvgSimilarity = this.config.get<number>('MERGE_AVG_SIMILARITY', 0.7);

    const exchangeEmbeddings = exchanges.map(e => e.embedding);
    const clusterCentroid = centroid(exchangeEmbeddings);

    const avgSimilarity =
      exchangeEmbeddings.reduce((acc, v) => acc + cosineSimilarity(v, clusterCentroid), 0) /
      exchangeEmbeddings.length;

    const existingMemory = await this.memoryRepo.findSimilarMemory(userId, clusterCentroid, mergeMaxSimilarity);
    const isMerge = existingMemory !== null && avgSimilarity >= mergeAvgSimilarity;

    return {
      messages: exchanges.flatMap(e => e.messages),
      memCentroid: clusterCentroid,
      existingMemory: isMerge ? existingMemory : null,
    };
  }

  private async callLlmForAnalysis(
    userId: string,
    messages: { id: string; role: string; provider: string | null; content: string }[],
    existingContent?: string | null,
  ): Promise<LlmMemoryAnalysis> {
    const inputArray = messages.map(m => ({
      [m.role === 'user' ? 'user' : (m.provider ?? 'assistant')]: {
        text: m.content,
        message_id: m.id,
      },
    }));

    const contextSection = existingContent ? `[기존 메모리]\n${existingContent}\n\n` : '';

    const prompt = `다음 대화 내용을 분석하여 JSON으로만 응답하세요.

${contextSection}[대화]
${JSON.stringify(inputArray, null, 2)}

{
  "keywords": [{"code": "영문-소문자-하이픈-슬러그", "name": "표시할 한국어명"}],
  "contents": ["기억할 문장1", "기억할 문장2"],
  "association": [["assistant-message-id"], ["assistant-message-id-1", "assistant-message-id-2"]],
  "summary": "한 문장 요약",
  "importance": 0.0,
  "durability": 0.0,
  "reusefulness": 0.0,
  "sensitivity": 0.0,
  "explicit_signal": 0.0,
  "llm_confidence_hint": 0.0,
  "temporary_penalty": 0.0
}

// contents: 대화에서 기억할 문장 배열
// association: contents와 같은 길이. association[i]는 contents[i]의 근거 message_id 목록
// association에는 assistant message_id만 포함 (user 메시지 제외)
// association[i]가 비어있는 contents[i]는 반환하지 말 것
// temporary_penalty: 장기 기억 가치가 낮을수록 높게 (오늘 날씨 → 높음, 직업/가치관 → 낮음)`;

    const fullContent = await this.modelService.chat(userId, [{ role: 'user', content: prompt }], { num_predict: 1024 });

    const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as LlmMemoryAnalysis;
  }

  private async runClustering(vectors: number[][], ids: string[]) {
    const url = this.config.get<string>('CLUSTERING_URL', 'http://clustering:8000');
    const minClusterSize = this.config.get<number>('CLUSTERING_MIN_CLUSTER_SIZE', 2);
    const similarityThreshold = this.config.get<number>('CLUSTERING_SIMILARITY_THRESHOLD', 0.95);
    const res = await fetch(`${url}/cluster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors, ids, min_cluster_size: minClusterSize, similarity_threshold: similarityThreshold }),
    });
    if (!res.ok) throw new Error(`Clustering error: ${res.status}`);
    return res.json();
  }

  async updateMainMemory(userId: string, batchResults: BatchMemoryResult[]) {
    const scoreThreshold = this.config.get<number>('PROMOTION_SCORE_THRESHOLD', 0.9);
    const sensitivityThreshold = this.config.get<number>('PROMOTION_SENSITIVITY_THRESHOLD', 0.3);

    const newlyPromoted = batchResults.filter(m =>
      m.is_pinned || (m.score > scoreThreshold && m.sensitivity <= sensitivityThreshold),
    );
    if (newlyPromoted.length === 0) return;

    const promoted = await this.memoryRepo.findPromotedMemories(userId, scoreThreshold, sensitivityThreshold);
    const existing = await this.memoryRepo.findMainMemory(userId);

    const newKnowledge = promoted.map(m => m.summary ?? '').filter(Boolean).join('\n---\n');

    const promptText = existing
      ? `다음은 사용자에 대해 알려진 정보입니다.\n\n[기존 기억]\n${existing.summary ?? ''}\n\n[새로 추가된 지식]\n${newKnowledge}\n\n위 내용을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.`
      : `다음은 사용자에 대해 알려진 정보입니다.\n\n[새로 추가된 지식]\n${newKnowledge}\n\n위 내용을 바탕으로 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.`;

    let mainSummary = '';
    for await (const token of this.modelService.chatStream(userId, [{ role: 'user', content: promptText }])) {
      mainSummary += token;
    }

    await this.memoryRepo.saveMainMemory(userId, mainSummary, existing);
  }
}
