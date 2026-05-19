import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ModelService } from '../model/model.service';

interface BatchMemoryResult {
  id: string;
  is_pinned: boolean;
  score: number;
  sensitivity: number;
}

interface LlmMemoryAnalysis {
  keywords: { code: string; name: string }[];
  contents: { order: number; text: string }[];
  summary: string;
  importance: number;
  durability: number;
  reusefulness: number;
  sensitivity: number;
  explicit_signal: number;
  llm_confidence_hint: number;
  temporary_penalty: number;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
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

function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  return sum.map(x => x / vectors.length);
}

@Injectable()
export class SchedulerService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private modelService: ModelService,
  ) {}

  @Cron('* * * * *')
  async checkAndRun() {
    const threshold = this.config.get<number>('SCHEDULER_MESSAGE_THRESHOLD', 5);
    const intervalHours = this.config.get<number>('SCHEDULER_BATCH_INTERVAL_HOURS', 24);

    const usersOverThreshold = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM message
      WHERE is_proceeded = false AND embedding IS NOT NULL
      GROUP BY user_id
      HAVING COUNT(*) >= ${threshold}
    `;

    const usersOverDay = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT u.id AS user_id FROM "user" u
      LEFT JOIN schedule s ON s.user_id = u.id AND s.type = 'memory_batch'
      WHERE (s.id IS NULL OR s.updated_at < NOW() - (${intervalHours} || ' hours')::interval)
        AND EXISTS (
          SELECT 1 FROM message m
          WHERE m.user_id = u.id AND m.is_proceeded = false AND m.embedding IS NOT NULL
        )
    `;

    const targetIds = [...new Set([
      ...usersOverThreshold.map(u => u.user_id),
      ...usersOverDay.map(u => u.user_id),
    ])];

    for (const user_id of targetIds) {
      try {
        const batchResults = await this.runBatch(user_id);
        await this.updateMainMemory(user_id, batchResults);
        await this.prisma.schedule.upsert({
          where: { user_id_type: { user_id, type: 'memory_batch' } },
          update: { updated_at: new Date() },
          create: { user_id, type: 'memory_batch' },
        });
      } catch (e) {
        console.error(`batch failed for user ${user_id}`, e);
      }
    }
  }

  async runBatch(userId: string): Promise<BatchMemoryResult[]> {
    const minClusterSize = this.config.get<number>('HDBSCAN_MIN_CLUSTER_SIZE', 2);

    const unprocessed = await this.prisma.$queryRaw<{ id: string; content: string; embedding: number[] }[]>`
      SELECT id, content, embedding::float4[] AS embedding
      FROM message
      WHERE user_id = ${userId}::uuid
        AND is_proceeded = false
        AND embedding IS NOT NULL
      ORDER BY created_at ASC
    `;

    if (unprocessed.length === 0) return [];

    const batchResults: BatchMemoryResult[] = [];

    if (unprocessed.length < minClusterSize) {
      for (const msg of unprocessed) {
        const result = await this.processSingleMessage(userId, msg);
        batchResults.push(result);
      }
    } else {
      const vectors = unprocessed.map(m => m.embedding);
      const ids = unprocessed.map(m => m.id);

      const clusterResult = await this.runClustering(vectors, ids);
      const msgMap = new Map(unprocessed.map(m => [m.id, m]));

      const clusterPromises = clusterResult.clusters.map((cluster: { label: number; ids: string[] }) =>
        this.processCluster(userId, cluster.ids.map(id => msgMap.get(id)!)),
      );
      const clusterMemories = await Promise.all(clusterPromises);
      for (const m of clusterMemories) batchResults.push(m);

      for (const noiseId of clusterResult.noise) {
        const msg = msgMap.get(noiseId)!;
        const result = await this.processSingleMessage(userId, msg);
        batchResults.push(result);
      }
    }

    // repetition_strength 갱신: 이번 배치 이전 knowledge memories와 비교
    const batchIds = batchResults.map(r => r.id);
    await this.updateRepetitionStrength(userId, unprocessed, batchIds);

    return batchResults;
  }

  private async processCluster(
    userId: string,
    messages: { id: string; content: string; embedding: number[] }[],
  ): Promise<BatchMemoryResult> {
    const mergeMaxSimilarity = this.config.get<number>('MERGE_MAX_SIMILARITY', 0.8);
    const mergeAvgSimilarity = this.config.get<number>('MERGE_AVG_SIMILARITY', 0.7);

    const clusterVectors = messages.map(m => m.embedding);
    const clusterCentroid = centroid(clusterVectors);

    const avgSimilarity =
      clusterVectors.reduce((acc, v) => acc + cosineSimilarity(v, clusterCentroid), 0) /
      clusterVectors.length;

    const existingMemory = await this.findSimilarMemory(userId, clusterCentroid, mergeMaxSimilarity);
    const isMerge = existingMemory !== null && avgSimilarity >= mergeAvgSimilarity;

    const contentText = messages.map(m => m.content).join('\n\n');
    const llmInput = isMerge && existingMemory
      ? `${existingMemory.content ?? ''}\n\n${contentText}`
      : contentText;

    const analysis = await this.callLlmForAnalysis(userId, llmInput);

    return this.saveMemory(userId, messages, clusterCentroid, analysis, isMerge ? existingMemory : null);
  }

  private async processSingleMessage(
    userId: string,
    msg: { id: string; content: string; embedding: number[] },
  ): Promise<BatchMemoryResult> {
    const mergeMaxSimilarity = this.config.get<number>('MERGE_MAX_SIMILARITY', 0.8);

    const existingMemory = await this.findSimilarMemory(userId, msg.embedding, mergeMaxSimilarity);
    const llmInput = existingMemory
      ? `${existingMemory.content ?? ''}\n\n${msg.content}`
      : msg.content;

    const analysis = await this.callLlmForAnalysis(userId, llmInput);

    return this.saveMemory(userId, [msg], msg.embedding, analysis, existingMemory);
  }

  private async findSimilarMemory(
    userId: string,
    vec: number[],
    threshold: number,
  ): Promise<{ id: string; content: string | null; version: number; root_memory_id: string | null } | null> {
    const rows = await this.prisma.$queryRaw<
      { id: string; content: string | null; version: number; root_memory_id: string | null; similarity: number }[]
    >`
      SELECT id, content, version, root_memory_id,
             (1 - (embedding <=> ${vec}::vector)) AS similarity
      FROM memory
      WHERE user_id = ${userId}::uuid
        AND type = 'knowledge'
        AND is_active = true
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::vector
      LIMIT 1
    `;

    if (rows.length === 0 || rows[0].similarity < threshold) return null;
    return rows[0];
  }

  private async callLlmForAnalysis(userId: string, contentText: string): Promise<LlmMemoryAnalysis> {
    const prompt = `다음 대화 내용을 분석하여 JSON으로만 응답하세요.

${contentText}

{
  "keywords": [{"code": "영문-소문자-하이픈-슬러그", "name": "표시할 한국어명"}],
  "contents": [{"order": 1, "text": "내용 청크"}],
  "summary": "한 문장 요약",
  "importance": 0.0,
  "durability": 0.0,
  "reusefulness": 0.0,
  "sensitivity": 0.0,
  "explicit_signal": 0.0,
  "llm_confidence_hint": 0.0,
  "temporary_penalty": 0.0
}

// temporary_penalty: 이 정보가 장기 기억으로 남길 가치가 낮을수록 높게 부여`;

    const messages = [{ role: 'user' as const, content: prompt }];
    let fullContent = '';

    for await (const token of this.modelService.chatStream(userId, messages)) {
      fullContent += token;
    }

    const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM response has no JSON');
    return JSON.parse(jsonMatch[0]) as LlmMemoryAnalysis;
  }

  private async saveMemory(
    userId: string,
    messages: { id: string; content: string; embedding: number[] }[],
    memCentroid: number[],
    analysis: LlmMemoryAnalysis,
    existingMemory: { id: string; version: number; root_memory_id: string | null } | null,
  ): Promise<BatchMemoryResult> {
    const maxClusterSize = this.config.get<number>('MAX_CLUSTER_SIZE', 50);
    const clusterSize = messages.length;
    const clusterSizeScore = Math.min(1, Math.log(1 + clusterSize) / Math.log(1 + maxClusterSize));
    const importance = clamp(clamp(analysis.importance) + 0.15 * clusterSizeScore);

    const confirmedScore = clamp(
      0.4 * clamp(analysis.explicit_signal) +
      0.3 * 0 + // repetition_strength is 0 at creation
      0.2 * 0 + // user_action_score
      0.1 * clamp(analysis.llm_confidence_hint),
    );

    const now = new Date();
    const recencyDays = 0; // 새로 생성된 메모리는 recency = 1
    const recency = Math.exp(-recencyDays / this.config.get<number>('RECENCY_DECAY_FACTOR', 30));

    const score = clamp(
      0.25 * importance +
      0.25 * clamp(analysis.durability) +
      0.20 * clamp(analysis.reusefulness) +
      0.20 * confirmedScore +
      0.10 * recency -
      0.30 * clamp(analysis.sensitivity) -
      0.30 * clamp(analysis.temporary_penalty),
    );

    if (existingMemory) {
      await this.prisma.memory.update({
        where: { id: existingMemory.id },
        data: { is_active: false, deactivated_at: now },
      });
    }

    const contentText = messages.map(m => m.content).join('\n\n');

    const newMemory = await this.prisma.memory.create({
      data: {
        user_id: userId,
        type: 'knowledge',
        history_type: existingMemory ? 'renewed' : 'created',
        version: existingMemory ? existingMemory.version + 1 : 1,
        parent_memory_id: existingMemory?.id ?? null,
        root_memory_id: existingMemory
          ? (existingMemory.root_memory_id ?? existingMemory.id)
          : null,
        score,
        scored_at: now,
        sensitivity: clamp(analysis.sensitivity),
        importance,
        durability: clamp(analysis.durability),
        reusefulness: clamp(analysis.reusefulness),
        explicit_signal: clamp(analysis.explicit_signal),
        llm_confidence_hint: clamp(analysis.llm_confidence_hint),
        confirmed_score: confirmedScore,
        temporary_penalty: clamp(analysis.temporary_penalty),
        summary: analysis.summary,
      },
    });

    // embedding 저장
    await this.prisma.$executeRaw`
      UPDATE memory SET embedding = ${memCentroid}::vector WHERE id = ${newMemory.id}::uuid
    `;

    // memory_contents 생성
    const contentRows = analysis.contents.map(c => ({
      memory_id: newMemory.id,
      content: c.text,
      order: c.order,
    }));
    await this.prisma.memory_content.createMany({ data: contentRows });

    // memory.content 갱신 (원문 합산)
    await this.prisma.memory.update({
      where: { id: newMemory.id },
      data: { content: contentText },
    });

    // keywords upsert + memory__keyword 연결
    for (const kw of analysis.keywords) {
      await this.prisma.$executeRaw`
        INSERT INTO keyword (code, name) VALUES (${kw.code}, ${kw.name})
        ON CONFLICT (code) DO NOTHING
      `;
      await this.prisma.$executeRaw`
        INSERT INTO memory__keyword (memory_id, keyword_code)
        VALUES (${newMemory.id}::uuid, ${kw.code})
        ON CONFLICT DO NOTHING
      `;
    }

    // memory_contents와 messages 연결
    const firstContent = await this.prisma.memory_content.findFirst({
      where: { memory_id: newMemory.id },
      orderBy: { order: 'asc' },
    });
    if (firstContent) {
      await this.prisma.memory_content__message.createMany({
        data: messages.map(m => ({ memory_content_id: firstContent.id, message_id: m.id })),
      });
    }

    // messages is_proceeded = true
    await this.prisma.message.updateMany({
      where: { id: { in: messages.map(m => m.id) } },
      data: { is_proceeded: true },
    });

    return {
      id: newMemory.id,
      is_pinned: newMemory.is_pinned,
      score,
      sensitivity: clamp(analysis.sensitivity),
    };
  }

  private async updateRepetitionStrength(
    userId: string,
    processedMessages: { id: string; embedding: number[] }[],
    batchIds: string[],
  ) {
    const similarityThreshold = this.config.get<number>('REPETITION_SIMILARITY_THRESHOLD', 0.6);

    const existingMemories = await this.prisma.$queryRaw<
      { id: string; embedding: number[] }[]
    >`
      SELECT id, embedding::float4[] AS embedding
      FROM memory
      WHERE user_id = ${userId}::uuid
        AND type = 'knowledge'
        AND is_active = true
        AND embedding IS NOT NULL
        AND id <> ALL(${batchIds}::uuid[])
    `;

    for (const memory of existingMemories) {
      let maxSim = 0;
      for (const msg of processedMessages) {
        const sim = cosineSimilarity(msg.embedding, memory.embedding);
        if (sim > maxSim) maxSim = sim;
      }
      if (maxSim >= similarityThreshold) {
        await this.prisma.$executeRaw`
          UPDATE memory
          SET repetition_strength = GREATEST(0, LEAST(1, repetition_strength + ${0.005 * maxSim}))
          WHERE id = ${memory.id}::uuid
        `;
      }
    }
  }

  private async runClustering(vectors: number[][], ids: string[]) {
    const url = this.config.get<string>('CLUSTERING_URL', 'http://clustering:8000');
    const minClusterSize = this.config.get<number>('HDBSCAN_MIN_CLUSTER_SIZE', 2);
    const res = await fetch(`${url}/cluster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors, ids, min_cluster_size: minClusterSize }),
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

    const promoted = await this.prisma.memory.findMany({
      where: {
        user_id: userId,
        type: 'knowledge',
        is_active: true,
        OR: [
          { is_pinned: true },
          { AND: [{ score: { gt: scoreThreshold } }, { sensitivity: { lte: sensitivityThreshold } }] },
        ],
      },
      select: { summary: true },
    });

    const existing = await this.prisma.memory.findFirst({
      where: { user_id: userId, type: 'main', is_active: true },
      select: { id: true, version: true, summary: true },
    });

    const newKnowledge = promoted.map(m => m.summary ?? '').filter(Boolean).join('\n---\n');

    let promptText: string;
    if (existing) {
      promptText = `다음은 사용자에 대해 알려진 정보입니다.\n\n[기존 기억]\n${existing.summary ?? ''}\n\n[새로 추가된 지식]\n${newKnowledge}\n\n위 내용을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.`;
    } else {
      promptText = `다음은 사용자에 대해 알려진 정보입니다.\n\n[새로 추가된 지식]\n${newKnowledge}\n\n위 내용을 바탕으로 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.`;
    }

    let mainSummary = '';
    for await (const token of this.modelService.chatStream(userId, [{ role: 'user', content: promptText }])) {
      mainSummary += token;
    }

    const now = new Date();
    if (existing) {
      await this.prisma.memory.update({
        where: { id: existing.id },
        data: { is_active: false, deactivated_at: now },
      });
    }

    await this.prisma.memory.create({
      data: {
        user_id: userId,
        type: 'main',
        history_type: 'renewed',
        version: existing ? existing.version + 1 : 1,
        parent_memory_id: existing?.id ?? null,
        root_memory_id: null,
        summary: mainSummary,
      },
    });
  }
}
