import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface BatchMemoryResult {
  id: string;
  is_pinned: boolean;
  score: number;
  sensitivity: number;
}

export interface LlmMemoryAnalysis {
  keywords: { code: string; name: string }[];
  contents: string[];
  associations?: string[][];
  summary: string;
  importance: number;
  durability: number;
  reusefulness: number;
  sensitivity: number;
  explicit_signal: number;
  llm_confidence_hint: number;
  temporary_penalty: number;
}

export interface MessageForBatch {
  id: string;
  role: string;
  provider: string | null;
  content: string;
  terms: string[];
}

export interface Exchange {
  id: string; // assistant message ID
  messages: MessageForBatch[];
  contentEmbeddings: number[][]; // message_content embeddings from the assistant message
}

export interface SaveArgs {
  messages: MessageForBatch[];
  memCentroid: number[];
  analysis: LlmMemoryAnalysis;
  existingMemory: { id: string; version: number; root_memory_id: string | null } | null;
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
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  return sum.map(x => x / vectors.length);
}

function computeScore(
  m: {
    importance: number; durability: number; reusefulness: number;
    explicit_signal: number; repetition_strength: number; user_action_score: number; llm_confidence_hint: number;
    sensitivity: number; temporary_penalty: number;
    last_referenced_at: Date | null; created_at: Date;
  },
  recencyDecayFactor: number,
): { confirmedScore: number; score: number } {
  const confirmedScore = clamp(
    0.4 * m.explicit_signal + 0.3 * m.repetition_strength +
    0.2 * m.user_action_score + 0.1 * m.llm_confidence_hint,
  );
  const days = (Date.now() - (m.last_referenced_at ?? m.created_at).getTime()) / 86400000;
  const recency = Math.exp(-days / recencyDecayFactor);
  const score = clamp(
    0.25 * m.importance + 0.25 * m.durability + 0.20 * m.reusefulness +
    0.20 * confirmedScore + 0.10 * recency -
    0.30 * m.sensitivity - 0.30 * m.temporary_penalty,
  );
  return { confirmedScore, score };
}

@Injectable()
export class MemoryRepository {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async findUnprocessedExchanges(userId: string): Promise<Exchange[]> {
    const assistantRows = await this.prisma.$queryRaw<
      (MessageForBatch & { parent_message_id: string | null })[]
    >`
      SELECT m.id, m.role, m.provider, m.content, m.terms, m.parent_message_id
      FROM message m
      WHERE m.user_id = ${userId}::uuid
        AND m.is_proceeded = false
        AND m.role != 'user'
        AND EXISTS (SELECT 1 FROM message_content mc WHERE mc.message_id = m.id)
      ORDER BY m.created_at ASC
    `;

    if (assistantRows.length === 0) return [];

    const assistantIds = assistantRows.map(m => m.id);
    const parentIds = assistantRows.map(m => m.parent_message_id).filter((id): id is string => id !== null);

    const [userRows, contentRows] = await Promise.all([
      parentIds.length > 0
        ? this.prisma.$queryRaw<MessageForBatch[]>`
            SELECT id, role, provider, content, terms
            FROM message
            WHERE id = ANY(${parentIds}::uuid[])
              AND is_proceeded = false
          `
        : Promise.resolve([] as MessageForBatch[]),
      this.prisma.$queryRaw<{ message_id: string; embedding: number[] }[]>`
        SELECT message_id, embedding::float4[] AS embedding
        FROM message_content
        WHERE message_id = ANY(${assistantIds}::uuid[])
        ORDER BY message_id, seq ASC
      `,
    ]);

    const userById = new Map(userRows.map(m => [m.id, m]));
    const contentEmbeddingsByMsgId = new Map<string, number[][]>();
    for (const row of contentRows) {
      if (!contentEmbeddingsByMsgId.has(row.message_id)) contentEmbeddingsByMsgId.set(row.message_id, []);
      contentEmbeddingsByMsgId.get(row.message_id)!.push(row.embedding);
    }

    return assistantRows.map(aMsg => {
      const messages: MessageForBatch[] = [];
      if (aMsg.parent_message_id) {
        const parent = userById.get(aMsg.parent_message_id);
        if (parent) messages.push(parent);
      }
      messages.push({ id: aMsg.id, role: aMsg.role, provider: aMsg.provider, content: aMsg.content, terms: aMsg.terms });
      return { id: aMsg.id, messages, contentEmbeddings: contentEmbeddingsByMsgId.get(aMsg.id) ?? [] };
    });
  }

  async findUsersOverThreshold(threshold: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM message m
      WHERE m.is_proceeded = false
        AND m.role != 'user'
        AND EXISTS (SELECT 1 FROM message_content mc WHERE mc.message_id = m.id)
      GROUP BY user_id
      HAVING COUNT(*) >= ${threshold}
    `;
    return rows.map(r => r.user_id);
  }

  async findUsersOverInterval(intervalHours: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT u.id AS user_id FROM "user" u
      LEFT JOIN schedule s ON s.user_id = u.id AND s.type = 'memory_batch'
      WHERE (s.id IS NULL OR s.updated_at < NOW() - (${intervalHours} || ' hours')::interval)
        AND EXISTS (
          SELECT 1 FROM message m
          WHERE m.user_id = u.id AND m.is_proceeded = false AND m.role != 'user'
            AND EXISTS (SELECT 1 FROM message_content mc WHERE mc.message_id = m.id)
        )
    `;
    return rows.map(r => r.user_id);
  }

  async findSimilarMemory(
    userId: string,
    vec: number[],
    threshold: number,
  ): Promise<{ id: string; version: number; root_memory_id: string | null; content: string | null } | null> {
    const rows = await this.prisma.$queryRaw<
      { id: string; version: number; root_memory_id: string | null; content: string | null; similarity: number }[]
    >`
      SELECT id, version, root_memory_id, content,
             (1 - (embedding <=> ${`[${vec.join(',')}]`}::vector)) AS similarity
      FROM memory
      WHERE user_id = ${userId}::uuid
        AND type = 'knowledge'
        AND is_active = true
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${`[${vec.join(',')}]`}::vector
      LIMIT 1
    `;

    if (rows.length === 0 || rows[0].similarity < threshold) return null;
    return rows[0];
  }

  async findMemoryMessages(rootId: string): Promise<MessageForBatch[]> {
    return this.prisma.$queryRaw<MessageForBatch[]>`
      SELECT id, role, provider, content, terms
      FROM message
      WHERE root_memory_id = ${rootId}::uuid
      ORDER BY created_at ASC
    `;
  }

  async saveMemory(
    tx: Prisma.TransactionClient,
    userId: string,
    { messages, memCentroid, analysis, existingMemory }: SaveArgs,
  ): Promise<BatchMemoryResult> {
    const maxClusterSize = Number(this.config.get('MAX_CLUSTER_SIZE', 50));
    const clusterSizeScore = Math.min(1, Math.log(1 + messages.length) / Math.log(1 + maxClusterSize));
    const importance = clamp(clamp(analysis.importance) + 0.15 * clusterSizeScore);
    const now = new Date();

    const { confirmedScore, score } = computeScore({
      importance,
      durability: clamp(analysis.durability),
      reusefulness: clamp(analysis.reusefulness),
      explicit_signal: clamp(analysis.explicit_signal),
      repetition_strength: 0,
      user_action_score: 0,
      llm_confidence_hint: clamp(analysis.llm_confidence_hint),
      sensitivity: clamp(analysis.sensitivity),
      temporary_penalty: clamp(analysis.temporary_penalty),
      last_referenced_at: null,
      created_at: now,
    }, Number(this.config.get('RECENCY_DECAY_FACTOR', 30)));

    const validPairs = (analysis.contents ?? [])
      .map((sentence, i) => {
        const raw = (analysis.associations ?? [])[i];
        const messageIds = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
        return { sentence, messageIds };
      })
      .filter(p => p.messageIds.length > 0);

    if (existingMemory) {
      await tx.memory.update({
        where: { id: existingMemory.id },
        data: { is_active: false, deactivated_at: now },
      });
    }

    const newMemory = await tx.memory.create({
      data: {
        user_id: userId,
        type: 'knowledge',
        history_type: existingMemory ? 'renewed' : 'created',
        version: existingMemory ? existingMemory.version + 1 : 1,
        parent_memory_id: existingMemory?.id ?? null,
        root_memory_id: existingMemory ? (existingMemory.root_memory_id ?? existingMemory.id) : null,
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
        content: validPairs.map(p => p.sentence).join('\n'),
      },
    });

    await tx.$executeRaw`
      UPDATE memory SET embedding = ${`[${memCentroid.join(',')}]`}::vector WHERE id = ${newMemory.id}::uuid
    `;

    const rootId = newMemory.root_memory_id ?? newMemory.id;
    const evidencedMessageIds = new Set<string>();

    for (const { sentence, messageIds } of validPairs) {
      const mc = await tx.memory_content.create({
        data: { memory_id: newMemory.id, content: sentence },
      });
      await tx.memory_content__message.createMany({
        data: messageIds.map(mid => ({ memory_content_id: mc.id, message_id: mid })),
      });
      messageIds.forEach(mid => evidencedMessageIds.add(mid));
    }

    if (evidencedMessageIds.size > 0) {
      await tx.message.updateMany({
        where: { id: { in: [...evidencedMessageIds] } },
        data: { root_memory_id: rootId },
      });
    }

    const normalizedKeywords = (analysis.keywords ?? [])
      .map(k => ({ ...k, code: k.code?.toLowerCase() }))
      .filter(k => k.code && /^[a-z0-9-]+$/.test(k.code));

    for (const kw of normalizedKeywords) {
      await tx.$executeRaw`
        INSERT INTO keyword (code, name) VALUES (${kw.code}, ${kw.name})
        ON CONFLICT (code) DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO memory__keyword (memory_id, keyword_code)
        VALUES (${newMemory.id}::uuid, ${kw.code})
        ON CONFLICT DO NOTHING
      `;
    }

    await tx.message.updateMany({
      where: { id: { in: messages.map(m => m.id) } },
      data: { is_proceeded: true },
    });

    return { id: newMemory.id, is_pinned: newMemory.is_pinned, score, sensitivity: clamp(analysis.sensitivity) };
  }

  // batchIds는 saveMemory 완료 후 생성된 id라 루프 중엔 알 수 없어 별도 단계로 분리됨
  async updateRepetitionStrength(
    tx: Prisma.TransactionClient,
    userId: string,
    contentEmbeddings: number[][],
    batchIds: string[],
  ) {
    if (contentEmbeddings.length === 0) return;
    const similarityThreshold = Number(this.config.get('REPETITION_SIMILARITY_THRESHOLD', 0.6));
    const recencyDecayFactor = Number(this.config.get('RECENCY_DECAY_FACTOR', 30));

    const existingMemories = await tx.$queryRaw<{
      id: string; embedding: number[];
      importance: number; durability: number; reusefulness: number;
      explicit_signal: number; repetition_strength: number; user_action_score: number;
      llm_confidence_hint: number; sensitivity: number; temporary_penalty: number;
      last_referenced_at: Date | null; created_at: Date;
    }[]>`
      SELECT id, embedding::float4[] AS embedding,
        importance, durability, reusefulness, explicit_signal, repetition_strength,
        user_action_score, llm_confidence_hint, sensitivity, temporary_penalty,
        last_referenced_at, created_at
      FROM memory
      WHERE user_id = ${userId}::uuid
        AND type = 'knowledge'
        AND is_active = true
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND id <> ALL(${batchIds}::uuid[])
    `;

    for (const memory of existingMemories) {
      let maxSim = 0;
      for (const emb of contentEmbeddings) {
        const sim = cosineSimilarity(emb, memory.embedding);
        if (sim > maxSim) maxSim = sim;
      }
      if (maxSim < similarityThreshold) continue;

      const repetitionStrength = Math.min(1, Math.max(0, memory.repetition_strength + 0.005 * maxSim));
      const { confirmedScore, score } = computeScore(
        { ...memory, repetition_strength: repetitionStrength },
        recencyDecayFactor,
      );

      await tx.memory.update({
        where: { id: memory.id },
        data: { repetition_strength: repetitionStrength, confirmed_score: confirmedScore, score, scored_at: new Date() },
      });
    }
  }

  async findPromotedMemories(userId: string, scoreThreshold: number, sensitivityThreshold: number) {
    return this.prisma.memory.findMany({
      where: {
        user_id: userId,
        type: 'knowledge',
        is_active: true,
        deleted_at: null,
        OR: [
          { is_pinned: true },
          { AND: [{ score: { gt: scoreThreshold } }, { sensitivity: { lte: sensitivityThreshold } }] },
        ],
      },
      select: { summary: true },
    });
  }

  async findMainMemory(userId: string) {
    return this.prisma.memory.findFirst({
      where: { user_id: userId, type: 'main', is_active: true, deleted_at: null },
      select: { id: true, version: true, summary: true, created_at: true },
    });
  }

  async getActiveMainMemory(userId: string): Promise<string | null> {
    const row = await this.prisma.memory.findFirst({
      where: { user_id: userId, type: 'main', is_active: true, deleted_at: null },
      select: { summary: true },
    });
    return row?.summary ?? null;
  }

  async getTopKnowledge(userId: string, embedding: number[], topK: number): Promise<{ id: string; summary: string }[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; summary: string }[]>`
      SELECT id, summary
      FROM memory
      WHERE user_id = ${userId}::uuid
        AND type = 'knowledge'
        AND is_active = true
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND summary IS NOT NULL
      ORDER BY embedding <=> ${`[${embedding.join(',')}]`}::vector
      LIMIT ${topK}
    `;

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      await this.prisma.$executeRaw`
        UPDATE memory
        SET last_referenced_at = NOW(),
            reference_count = reference_count + 1
        WHERE id = ANY(${ids}::uuid[])
      `;
    }

    return rows;
  }

  async getKnowledgeList(userId: string) {
    return this.prisma.memory.findMany({
      where: { user_id: userId, type: 'knowledge', is_active: true, deleted_at: null },
      orderBy: { created_at: 'desc' },
      include: {
        keywords: { include: { keyword: true } },
        contents: true,
      },
    });
  }

  async getKeywordDashboard(userId: string) {
    return this.prisma.$queryRaw<{ code: string; name: string; frequency: number }[]>`
      SELECT k.code, k.name, COUNT(*)::int AS frequency
      FROM memory__keyword mk
      JOIN keyword k ON k.code = mk.keyword_code
      JOIN memory m ON m.id = mk.memory_id
      WHERE m.user_id = ${userId}::uuid AND m.type = 'knowledge' AND m.is_active = true AND m.deleted_at IS NULL
      GROUP BY k.code, k.name
      ORDER BY frequency DESC
    `;
  }

  async getKnowledgeByKeyword(userId: string, code: string) {
    return this.prisma.memory.findMany({
      where: {
        user_id: userId, type: 'knowledge', is_active: true, deleted_at: null,
        keywords: { some: { keyword_code: code } },
      },
      orderBy: { created_at: 'desc' },
      include: {
        keywords: { include: { keyword: true } },
        contents: true,
      },
    });
  }

  async findKnowledgeMemory(userId: string, id: string) {
    return this.prisma.memory.findFirst({
      where: { id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null },
      include: { keywords: { include: { keyword: true } }, contents: true },
    });
  }

  async findMemoryHistory(userId: string, id: string) {
    const target = await this.prisma.memory.findFirst({
      where: { id, user_id: userId, type: 'knowledge', deleted_at: null },
      select: { id: true, root_memory_id: true },
    });
    if (!target) return [];
    const rootId = target.root_memory_id ?? target.id;

    return this.prisma.memory.findMany({
      where: {
        user_id: userId, type: 'knowledge', deleted_at: null,
        OR: [{ id: rootId }, { root_memory_id: rootId }],
      },
      orderBy: { version: 'desc' },
      include: { keywords: { include: { keyword: true } }, contents: true },
    });
  }

  async togglePin(userId: string, id: string) {
    const memory = await this.prisma.memory.findFirst({
      where: { id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null },
    });
    if (!memory) return null;

    if (!memory.is_pinned) {
      const maxPinned = Number(this.config.get('PIN_MAX_COUNT', 20));
      const pinnedCount = await this.prisma.memory.count({
        where: { user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: true },
      });
      if (pinnedCount >= maxPinned) throw new Error('PIN_LIMIT_EXCEEDED');
    }

    return this.prisma.memory.update({
      where: { id },
      data: { is_pinned: !memory.is_pinned },
    });
  }

  async updateKnowledgeMemory(userId: string, id: string, contents: string[], summary: string) {
    const existing = await this.prisma.memory.findFirst({
      where: { id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null },
    });
    if (!existing) return null;

    return this.prisma.$transaction(async (tx) => {
      await tx.memory.update({
        where: { id },
        data: { is_active: false, deactivated_at: new Date() },
      });

      const newMemory = await tx.memory.create({
        data: {
          user_id: userId,
          type: 'knowledge',
          history_type: 'modified',
          version: existing.version + 1,
          parent_memory_id: existing.id,
          root_memory_id: existing.root_memory_id ?? existing.id,
          is_pinned: existing.is_pinned,
          content: contents.join('\n'),
          summary,
          // score 컴포넌트는 기존 값 그대로 carry (재계산 안 함 — 유저가 내용만 고친 것)
          score: existing.score, sensitivity: existing.sensitivity, importance: existing.importance,
          durability: existing.durability, reusefulness: existing.reusefulness,
          explicit_signal: existing.explicit_signal, repetition_strength: existing.repetition_strength,
          user_action_score: existing.user_action_score, llm_confidence_hint: existing.llm_confidence_hint,
          confirmed_score: existing.confirmed_score, temporary_penalty: existing.temporary_penalty,
          scored_at: existing.scored_at, last_referenced_at: existing.last_referenced_at,
          reference_count: existing.reference_count,
        },
      });

      for (const sentence of contents) {
        await tx.memory_content.create({ data: { memory_id: newMemory.id, content: sentence } });
        // 결정 C: message 근거 연결 없음
      }
      // keyword는 편집 대상이 아니므로 기존 값 그대로 복사 (안 하면 Spec2에서 고친 것과 같은 유실 버그 재발)
      await tx.$executeRaw`
        INSERT INTO memory__keyword (memory_id, keyword_code)
        SELECT ${newMemory.id}::uuid, keyword_code FROM memory__keyword WHERE memory_id = ${existing.id}::uuid
        ON CONFLICT DO NOTHING
      `;
      await tx.$executeRaw`UPDATE memory SET embedding = (SELECT embedding FROM memory WHERE id = ${existing.id}::uuid) WHERE id = ${newMemory.id}::uuid`;

      return newMemory;
    });
  }

  async deleteKnowledgeMemory(userId: string, id: string) {
    const target = await this.prisma.memory.findFirst({
      where: { id, user_id: userId, type: 'knowledge', deleted_at: null },
      select: { id: true, root_memory_id: true },
    });
    if (!target) return null;
    const rootId = target.root_memory_id ?? target.id;

    const versionIds = (await this.prisma.memory.findMany({
      where: { user_id: userId, type: 'knowledge', OR: [{ id: rootId }, { root_memory_id: rootId }] },
      select: { id: true },
    })).map(v => v.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.memory_content__message.deleteMany({ where: { memory_content: { memory_id: { in: versionIds } } } });
      await tx.memory_content.deleteMany({ where: { memory_id: { in: versionIds } } });
      await tx.memory__keyword.deleteMany({ where: { memory_id: { in: versionIds } } });
      await tx.memory.updateMany({
        where: { id: { in: versionIds } },
        data: { deleted_at: new Date(), is_active: false, deactivated_at: new Date() },
      });

      // memory_content__message는 N:M이라 message 하나가 다른(삭제 대상 아닌) memory의
      // 근거로 여전히 쓰이고 있을 수 있음 — 완전히 퇴출된 message만 root_memory_id를 null로 리셋
      const candidates = await tx.message.findMany({ where: { root_memory_id: rootId }, select: { id: true } });
      const stillReferenced = new Set(
        (await tx.memory_content__message.findMany({
          where: { message_id: { in: candidates.map(m => m.id) } },
          select: { message_id: true },
          distinct: ['message_id'],
        })).map(r => r.message_id),
      );
      const toReset = candidates.map(m => m.id).filter(mid => !stillReferenced.has(mid));

      await tx.message.updateMany({ where: { id: { in: toReset } }, data: { root_memory_id: null } });
    });

    return { id: target.id };
  }

  async applyDecay() {
    const recencyDecayFactor = Number(this.config.get('RECENCY_DECAY_FACTOR', 30));
    const memories = await this.prisma.memory.findMany({
      where: { type: 'knowledge', is_active: true, deleted_at: null },
    });
    for (const m of memories) {
      const repetitionStrength = Math.min(1, Math.max(0, m.repetition_strength * 0.995));
      const { confirmedScore, score } = computeScore({ ...m, repetition_strength: repetitionStrength }, recencyDecayFactor);
      await this.prisma.memory.update({
        where: { id: m.id },
        data: { repetition_strength: repetitionStrength, confirmed_score: confirmedScore, score, scored_at: new Date() },
      });
    }
  }

  async saveMainMemory(
    userId: string,
    summary: string,
    existing: { id: string; version: number } | null,
    historyType: 'renewed' | 'modified' = 'renewed',
  ) {
    const now = new Date();
    if (existing) {
      await this.prisma.memory.update({
        where: { id: existing.id },
        data: { is_active: false, deactivated_at: now },
      });
    }
    return this.prisma.memory.create({
      data: {
        user_id: userId,
        type: 'main',
        history_type: historyType,
        version: existing ? existing.version + 1 : 1,
        parent_memory_id: existing?.id ?? null,
        root_memory_id: null,
        summary,
      },
    });
  }

  async findContentMessages(userId: string, contentId: string) {
    return this.prisma.$queryRaw<{ id: string; role: string; provider: string | null; content: string; created_at: Date }[]>`
      SELECT m.id, m.role, m.provider, m.content, m.created_at
      FROM memory_content__message mcm
      JOIN message m ON m.id = mcm.message_id
      JOIN memory_content mc ON mc.id = mcm.memory_content_id
      JOIN memory mem ON mem.id = mc.memory_id
      WHERE mcm.memory_content_id = ${contentId}::uuid
        AND mem.user_id = ${userId}::uuid
      ORDER BY m.created_at ASC
    `;
  }

  async logAssociations(
    contentEmbeddings: number[][],
    messageIds: string[],
  ): Promise<void> {
    if (contentEmbeddings.length === 0 || messageIds.length === 0) {
      console.log('[logAssociations] empty input');
      return;
    }

    const embArrayLiteral = contentEmbeddings
      .map(e => `'[${e.join(',')}]'::vector(768)`)
      .join(',');
    const messageIdList = messageIds.map(id => `'${id}'::uuid`).join(',');

    const rows = await this.prisma.$queryRawUnsafe<{
      content_idx: number;
      message_id: string;
      top1: number;
      top2: number | null;
      final_score: number;
    }[]>(`
      WITH query_embeddings AS (
        SELECT
          ordinality - 1       AS content_idx,
          embedding            AS query_embedding
        FROM unnest(ARRAY[${embArrayLiteral}]) WITH ORDINALITY AS t(embedding, ordinality)
      ),
      scored AS (
        SELECT
          qe.content_idx,
          mc.message_id,
          1 - (mc.embedding <=> qe.query_embedding) AS similarity,
          ROW_NUMBER() OVER (
            PARTITION BY qe.content_idx, mc.message_id
            ORDER BY mc.embedding <=> qe.query_embedding
          ) AS rn
        FROM query_embeddings qe
        CROSS JOIN message_content mc
        WHERE mc.message_id = ANY(ARRAY[${messageIdList}])
      ),
      top2 AS (
        SELECT
          content_idx,
          message_id,
          MAX(CASE WHEN rn = 1 THEN similarity END) AS top1,
          MAX(CASE WHEN rn = 2 THEN similarity END) AS top2
        FROM scored
        WHERE rn <= 2
        GROUP BY content_idx, message_id
      )
      SELECT
        content_idx,
        message_id,
        top1,
        top2,
        CASE WHEN top2 IS NULL THEN top1 ELSE top1 * 0.7 + top2 * 0.3 END AS final_score
      FROM top2
      ORDER BY content_idx, final_score DESC
    `);

    console.log('[logAssociations]', JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2));
  }

  async findAssociations(
    contentEmbeddings: number[][],
    messageIds: string[],
  ): Promise<string[][]> {
    if (contentEmbeddings.length === 0 || messageIds.length === 0) {
      return contentEmbeddings.map(() => []);
    }

    const embArrayLiteral = contentEmbeddings
      .map(e => `'[${e.join(',')}]'::vector(768)`)
      .join(',');
    const messageIdList = messageIds.map(id => `'${id}'::uuid`).join(',');

    const rows = await this.prisma.$queryRawUnsafe<{ content_idx: number; message_id: string; final_score: number }[]>(`
      WITH query_embeddings AS (
        SELECT
          ordinality - 1       AS content_idx,
          embedding            AS query_embedding
        FROM unnest(ARRAY[${embArrayLiteral}]) WITH ORDINALITY AS t(embedding, ordinality)
      ),
      scored AS (
        SELECT
          qe.content_idx,
          mc.message_id,
          1 - (mc.embedding <=> qe.query_embedding) AS similarity,
          ROW_NUMBER() OVER (
            PARTITION BY qe.content_idx, mc.message_id
            ORDER BY mc.embedding <=> qe.query_embedding
          ) AS rn
        FROM query_embeddings qe
        CROSS JOIN message_content mc
        WHERE mc.message_id = ANY(ARRAY[${messageIdList}])
      ),
      top2 AS (
        SELECT
          content_idx,
          message_id,
          MAX(CASE WHEN rn = 1 THEN similarity END) AS top1,
          MAX(CASE WHEN rn = 2 THEN similarity END) AS top2
        FROM scored
        WHERE rn <= 2
        GROUP BY content_idx, message_id
      )
      SELECT
        content_idx,
        message_id,
        CASE WHEN top2 IS NULL THEN top1 ELSE top1 * 0.7 + top2 * 0.3 END AS final_score
      FROM top2
      WHERE CASE WHEN top2 IS NULL THEN top1 ELSE top1 * 0.7 + top2 * 0.3 END >= 0.75
      ORDER BY content_idx, final_score DESC
    `);

    const associations: string[][] = contentEmbeddings.map(() => []);
    for (const row of rows) {
      associations[row.content_idx].push(row.message_id);
    }
    return associations;
  }
}
