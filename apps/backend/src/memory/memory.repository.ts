import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Prisma} from '@prisma/client';
import {PrismaService} from '../prisma/prisma.service';
import {MessageRepository} from '../message/message.repository';
import {ModelService} from '../model/model.service';

const KEYWORD_WEIGHT_THRESHOLD = 0.5;

export interface BatchMemoryResult {
  id: string;
  newContentIds: string[];
}

export interface LlmContentScore {
  text: string;
  importance: number;
  durability: number;
  reusefulness: number;
  sensitivity: number;
  explicit_signal: number;
  llm_confidence_hint: number;
}

export interface LlmMemoryAnalysis {
  keywords: { code: string; name: string, weight?: number }[];
  contents: LlmContentScore[];
  associations?: string[][];
  summary: string;
}

export interface SaveArgs {
  messageIds: string[];
  analysis: LlmMemoryAnalysis;
  existingMemory: { id: string; version: number; root_memory_id: string | null } | null;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function computeScore(
  c: {
    importance: number; durability: number; reusefulness: number;
    explicit_signal: number; repetition_count: number; llm_confidence_hint: number;
    sensitivity: number;
    last_referenced_at: Date | null; created_at: Date;
  },
  recencyDecayFactor: number,
  repetitionNormCap: number,
): { confirmedScore: number; score: number } {
  const repetitionStrength = Math.min(1, Math.log2(c.repetition_count + 1) / Math.log2(repetitionNormCap + 1));
  const confirmedScore = clamp(
    0.5 * c.explicit_signal + 0.35 * repetitionStrength + 0.15 * c.llm_confidence_hint,
  );
  const days = (Date.now() - (c.last_referenced_at ?? c.created_at).getTime()) / 86400000;
  const recency = Math.exp(-days / recencyDecayFactor);
  const score = clamp(
    0.25 * c.importance + 0.30 * c.durability + 0.20 * c.reusefulness +
    0.20 * confirmedScore + 0.10 * recency -
    0.10 * c.sensitivity,
  );
  return {confirmedScore, score};
}

@Injectable()
export class MemoryRepository {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private messageRepo: MessageRepository,
    private modelService: ModelService,
  ) {
  }

  async findSimilarMemory(
    userId: string,
    vec: number[],
    threshold: number,
  ): Promise<{ id: string; version: number; root_memory_id: string | null } | null> {
    const rows = await this.prisma.$queryRaw<
      { id: string; version: number; root_memory_id: string | null; similarity: number }[]
    >`
        SELECT id,
               version,
               root_memory_id,
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

  async logSimilarMemory(userId: string, vec: number[]): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      { id: string; version: number; summary: string | null; similarity: number }[]
    >`
        SELECT id,
               version, summary, (1 - (embedding <=>
               ${`[${vec.join(',')}]`}::vector)) AS similarity
        FROM memory
        WHERE user_id = ${userId}::uuid
          AND type = 'knowledge'
          AND is_active = true
          AND deleted_at IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${`[${vec.join(',')}]`}::vector
            LIMIT 10
    `;

    console.log('[logSimilarMemory]', JSON.stringify(rows, null, 2));
  }

  async saveMemory(
    tx: Prisma.TransactionClient,
    userId: string,
    {messageIds, analysis, existingMemory}: SaveArgs,
  ): Promise<BatchMemoryResult> {
    const maxClusterSize = Number(this.config.get('MAX_CLUSTER_SIZE', 50));
    const clusterSizeScore = Math.min(1, Math.log(1 + messageIds.length) / Math.log(1 + maxClusterSize));
    const recencyDecayFactor = Number(this.config.get('RECENCY_DECAY_FACTOR', 30));
    const repetitionNormCap = Number(this.config.get('REPETITION_NORM_CAP', 10));
    const forgettingScoreThreshold = Number(this.config.get('FORGETTING_SCORE_THRESHOLD', 0.2));
    const forgettingStaleDays = Number(this.config.get('FORGETTING_STALE_DAYS', 60));
    const now = new Date();

    // existingMemory의 현재 조인(= 이전 버전의 content 전체) 조회 — carry 여부 판단 + "동일하면 스킵" 비교 기준
    const previousJoins = existingMemory
      ? await tx.memory__memory_content.findMany({
        where: {memory_id: existingMemory.id},
        include: {memory_content: true},
        orderBy: {seq: 'asc'},
      })
      : [];
    const existingRow = existingMemory
      ? await tx.memory.findUniqueOrThrow({where: {id: existingMemory.id}, select: {summary: true, is_pinned: true}})
      : null;

    // 결정 F/4번: forgetting 조건(score 낮음 AND stale) 통과 못한 content는 carry에서 제외
    const carried = previousJoins.filter(j => {
      const c = j.memory_content;
      const days = (Date.now() - (c.last_referenced_at ?? c.created_at).getTime()) / 86400000;
      return !(c.score < forgettingScoreThreshold && days > forgettingStaleDays);
    });

    const validPairs = (analysis.contents ?? [])
      .map((content, i) => {
        const raw = (analysis.associations ?? [])[i];
        const evidenceIds = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
        return {content, evidenceIds};
      })
      .filter(p => p.evidenceIds.length > 0);

    const newEmbeddings = validPairs.length > 0
      ? await this.modelService.embedTexts(validPairs.map(p => p.content.text), 'search_document: ')
      : [];

    // 결정 B: carry + 신규 결과가 이전 버전과 완전히 동일(content id 집합 기준, 순서 무관)하면 새 버전 생성 스킵
    if (existingMemory && validPairs.length === 0) {
      const previousIds = previousJoins.map(j => j.memory_content_id).sort();
      const carriedIds = carried.map(j => j.memory_content_id).sort();
      const unchanged = previousIds.length === carriedIds.length && previousIds.every((id, i) => id === carriedIds[i]);
      if (unchanged) return {id: existingMemory.id, newContentIds: []};
    }

    if (existingMemory) {
      await tx.memory.update({
        where: {id: existingMemory.id},
        data: {is_active: false, deactivated_at: now},
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
        is_pinned: existingRow?.is_pinned ?? false,
        summary: validPairs.length > 0 ? analysis.summary : (existingRow?.summary ?? analysis.summary),
      },
    });

    let seq = 0;
    for (const j of carried) {
      await tx.memory__memory_content.create({data: {memory_id: newMemory.id, memory_content_id: j.memory_content_id, seq: seq++}});
    }

    const rootId = newMemory.root_memory_id ?? newMemory.id;
    const evidencedMessageIds = new Set<string>();
    const newContentIds: string[] = [];

    for (let i = 0; i < validPairs.length; i++) {
      const {content, evidenceIds} = validPairs[i];
      const importance = clamp(clamp(content.importance) + 0.15 * clusterSizeScore);
      const {confirmedScore, score} = computeScore({
        importance,
        durability: clamp(content.durability),
        reusefulness: clamp(content.reusefulness),
        explicit_signal: clamp(content.explicit_signal),
        repetition_count: 0,
        llm_confidence_hint: clamp(content.llm_confidence_hint),
        sensitivity: clamp(content.sensitivity),
        last_referenced_at: null,
        created_at: now,
      }, recencyDecayFactor, repetitionNormCap);

      const mc = await tx.memory_content.create({
        data: {
          content: content.text, importance, durability: clamp(content.durability),
          reusefulness: clamp(content.reusefulness), sensitivity: clamp(content.sensitivity),
          explicit_signal: clamp(content.explicit_signal), llm_confidence_hint: clamp(content.llm_confidence_hint),
          confirmed_score: confirmedScore, score, scored_at: now,
        },
      });
      await tx.$executeRaw`UPDATE memory_content SET embedding = ${`[${newEmbeddings[i].join(',')}]`}::vector WHERE id = ${mc.id}::uuid`;
      await tx.memory__memory_content.create({data: {memory_id: newMemory.id, memory_content_id: mc.id, seq: seq++}});
      await tx.memory_content__message.createMany({
        data: evidenceIds.map(mid => ({memory_content_id: mc.id, message_id: mid})),
      });
      evidenceIds.forEach(mid => evidencedMessageIds.add(mid));
      newContentIds.push(mc.id);
    }

    if (evidencedMessageIds.size > 0) {
      await this.messageRepo.updateRootMemoryId(tx, [...evidencedMessageIds], rootId);
    }

    // keyword는 기존 버전 것을 그대로 carry(복사) 후, 이번 배치에서 새로 추출된 것만 추가
    if (existingMemory) {
      await tx.$executeRaw`
          INSERT INTO memory__keyword (memory_id, keyword_code, weight)
          SELECT ${newMemory.id}::uuid, keyword_code, weight
          FROM memory__keyword
          WHERE memory_id = ${existingMemory.id}::uuid
          ON CONFLICT DO NOTHING
      `;
    }

    const normalizedKeywords = (analysis.keywords ?? [])
      .map(k => ({...k, code: k.code?.toLowerCase().replace(/_/g, '-')}))
      .filter(k => k.code && /^[a-z0-9-]+$/.test(k.code));

    for (const kw of normalizedKeywords) {
      await tx.$executeRaw`
          INSERT INTO keyword (code, name)
          VALUES (${kw.code}, ${kw.name}) ON CONFLICT (code) DO NOTHING
      `;
      await tx.$executeRaw`
          INSERT INTO memory__keyword (memory_id, keyword_code, weight)
          VALUES (${newMemory.id}::uuid, ${kw.code}, ${kw.weight ?? 1}) ON CONFLICT (memory_id, keyword_code) DO UPDATE SET weight = EXCLUDED.weight
      `;
    }

    // 그룹 centroid(memory.embedding) — 최종 조인된 content 전체 embedding의 평균으로 재계산
    const allContentEmbeddings = await tx.$queryRaw<{ embedding: number[] }[]>`
        SELECT embedding::float4[] AS embedding
        FROM memory_content mc
                 JOIN memory__memory_content mmc ON mmc.memory_content_id = mc.id
        WHERE mmc.memory_id = ${newMemory.id}::uuid
        AND mc.embedding IS NOT NULL
    `;
    if (allContentEmbeddings.length > 0) {
      const centroid = this.modelService.getAverageCentroid(allContentEmbeddings.map(r => r.embedding));
      await tx.$executeRaw`UPDATE memory SET embedding = ${`[${centroid.join(',')}]`}::vector WHERE id = ${newMemory.id}::uuid`;
    }

    // 결정 B/F: 조인된 content가 0개인 새 버전은 그 버전만 비활성 처리(lineage/parent는 안 건드림)
    if (carried.length + newContentIds.length === 0) {
      await tx.memory.update({where: {id: newMemory.id}, data: {is_active: false, deactivated_at: now}});
    }

    return {id: newMemory.id, newContentIds};
  }

  // 결정 5번: 새로 만든 content embedding마다 pgvector로 가장 유사한 기존 content를 찾아 repetition_count 증가
  async detectRepetitions(
    tx: Prisma.TransactionClient,
    userId: string,
    newContentIds: string[],
  ) {
    if (newContentIds.length === 0) return;
    const similarityThreshold = Number(this.config.get('REPETITION_SIMILARITY_THRESHOLD', 0.6));

    const newContents = await tx.$queryRaw<{ id: string; embedding: number[] }[]>`
        SELECT id, embedding::float4[] AS embedding
        FROM memory_content
        WHERE id = ANY (${newContentIds}::uuid[])
        AND embedding IS NOT NULL
    `;

    for (const content of newContents) {
      const vecLiteral = `[${content.embedding.join(',')}]`;
      const matches = await tx.$queryRaw<{ id: string; similarity: number }[]>`
          SELECT mc.id, (1 - (mc.embedding <=> ${vecLiteral}::vector)) AS similarity
          FROM memory_content mc
                   JOIN memory__memory_content mmc ON mmc.memory_content_id = mc.id
                   JOIN memory m ON m.id = mmc.memory_id
          WHERE m.user_id = ${userId}::uuid
          AND m.type = 'knowledge'
          AND m.is_active = true
          AND m.deleted_at IS NULL
          AND mc.embedding IS NOT NULL
          AND mc.id <> ALL (${newContentIds}::uuid[])
          ORDER BY mc.embedding <=> ${vecLiteral}::vector
              LIMIT 1
      `;
      if (matches.length === 0 || matches[0].similarity < similarityThreshold) continue;

      await tx.$executeRaw`
          UPDATE memory_content
          SET repetition_count   = repetition_count + 1,
              last_referenced_at = NOW()
          WHERE id = ${matches[0].id}::uuid
      `;
    }
  }

  async findPromotedContents(userId: string, scoreThreshold: number, sensitivityThreshold: number) {
    const totalActive = await this.prisma.memory.count({
      where: {user_id: userId, type: 'knowledge', is_active: true, deleted_at: null},
    });
    // 결정 E: memory_content 단위로 내려가면서 기존 공식에 *5를 곱함 — 임의 선택, 재조정 필요(todo.md)
    const topN = Math.max(3, Math.ceil(Math.log2(totalActive + 1))) * 5;

    const ranked = await this.prisma.memory_content.findMany({
      where: {
        score: {gt: scoreThreshold}, sensitivity: {lte: sensitivityThreshold},
        memory_versions: {
          some: {memory: {user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: false}},
        },
      },
      orderBy: {score: 'desc'},
      take: topN,
      select: {content: true},
    });

    const pinned = await this.prisma.memory_content.findMany({
      where: {
        memory_versions: {
          some: {memory: {user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: true}},
        },
      },
      select: {content: true},
    });

    return [...ranked, ...pinned];
  }

  async findMainMemory(userId: string) {
    const row = await this.prisma.memory.findFirst({
      where: {user_id: userId, type: 'main', is_active: true, deleted_at: null},
      select: {
        id: true, version: true, created_at: true,
        content_joins: {select: {memory_content: {select: {id: true, content: true}}}, orderBy: {seq: 'asc'}},
      },
    });
    if (!row) return null;
    const {content_joins, ...rest} = row;
    return {...rest, contents: content_joins.map(j => j.memory_content)};
  }

  async getActiveMainMemory(userId: string): Promise<string | null> {
    const row = await this.prisma.memory.findFirst({
      where: {user_id: userId, type: 'main', is_active: true, deleted_at: null},
      select: {content_joins: {select: {memory_content: {select: {content: true}}}, orderBy: {seq: 'asc'}}},
    });
    if (!row || row.content_joins.length === 0) return null;
    return row.content_joins.map(j => j.memory_content.content).join('\n');
  }

  async getTopKnowledge(userId: string, embedding: number[], topN: number): Promise<{ id: string; summary: string }[]> {
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
            LIMIT ${topN}
    `;

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      await this.prisma.$executeRaw`
          UPDATE memory
          SET last_referenced_at = NOW(),
              reference_count    = reference_count + 1
          WHERE id = ANY (${ids}::uuid[])
      `;
    }

    return rows;
  }

  private withContents<T extends { content_joins: { seq: number; memory_content: { id: string; content: string } }[] }>(
    m: T,
  ) {
    const {content_joins, ...rest} = m;
    return {...rest, contents: content_joins.map(j => j.memory_content)};
  }

  private static readonly knowledgeInclude = {
    keywords: {where: {weight: {gte: KEYWORD_WEIGHT_THRESHOLD}}, include: {keyword: true}},
    content_joins: {include: {memory_content: true}, orderBy: {seq: 'asc' as const}},
  };

  async getKnowledgeList(userId: string) {
    const rows = await this.prisma.memory.findMany({
      where: {user_id: userId, type: 'knowledge', is_active: true, deleted_at: null},
      orderBy: {created_at: 'desc'},
      include: MemoryRepository.knowledgeInclude,
    });
    return rows.map(m => this.withContents(m));
  }

  async getKeywordDashboard(userId: string) {
    return this.prisma.$queryRaw<{ code: string; name: string; frequency: number }[]>`
        SELECT k.code, k.name, COUNT(*) ::int AS frequency
        FROM memory__keyword mk
                 JOIN keyword k ON k.code = mk.keyword_code
                 JOIN memory m ON m.id = mk.memory_id
        WHERE m.user_id = ${userId}::uuid AND m.type = 'knowledge' AND m.is_active = true AND m.deleted_at IS NULL
        AND mk.weight >= ${KEYWORD_WEIGHT_THRESHOLD}
        GROUP BY k.code, k.name
        ORDER BY frequency DESC
    `;
  }

  async getKnowledgeByKeyword(userId: string, code: string) {
    const rows = await this.prisma.memory.findMany({
      where: {
        user_id: userId, type: 'knowledge', is_active: true, deleted_at: null,
        keywords: {some: {keyword_code: code, weight: {gte: KEYWORD_WEIGHT_THRESHOLD}}},
      },
      orderBy: {created_at: 'desc'},
      include: MemoryRepository.knowledgeInclude,
    });
    return rows.map(m => this.withContents(m));
  }

  async findKnowledgeMemory(userId: string, id: string) {
    const row = await this.prisma.memory.findFirst({
      where: {id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null},
      include: MemoryRepository.knowledgeInclude,
    });
    return row ? this.withContents(row) : null;
  }

  async findMemoryHistory(userId: string, id: string) {
    const target = await this.prisma.memory.findFirst({
      where: {id, user_id: userId, type: 'knowledge', deleted_at: null},
      select: {id: true, root_memory_id: true},
    });
    if (!target) return [];
    const rootId = target.root_memory_id ?? target.id;

    const rows = await this.prisma.memory.findMany({
      where: {
        user_id: userId, type: 'knowledge', deleted_at: null,
        OR: [{id: rootId}, {root_memory_id: rootId}],
      },
      orderBy: {version: 'desc'},
      include: MemoryRepository.knowledgeInclude,
    });
    return rows.map(m => this.withContents(m));
  }

  async togglePin(userId: string, id: string) {
    const memory = await this.prisma.memory.findFirst({
      where: {id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null},
    });
    if (!memory) return null;

    if (!memory.is_pinned) {
      const maxPinned = Number(this.config.get('PIN_MAX_COUNT', 20));
      const pinnedCount = await this.prisma.memory.count({
        where: {user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: true},
      });
      if (pinnedCount >= maxPinned) throw new Error('PIN_LIMIT_EXCEEDED');
    }

    return this.prisma.memory.update({
      where: {id},
      data: {is_pinned: !memory.is_pinned},
    });
  }

  async updateKnowledgeMemory(userId: string, id: string, contents: { id?: string; text: string }[], summary: string) {
    const existing = await this.prisma.memory.findFirst({
      where: {id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null},
    });
    if (!existing) return null;

    return this.prisma.$transaction(async (tx) => {
      const existingJoins = await tx.memory__memory_content.findMany({
        where: {memory_id: existing.id},
        include: {memory_content: true},
      });
      const existingById = new Map(existingJoins.map(j => [j.memory_content_id, j.memory_content]));

      await tx.memory.update({
        where: {id},
        data: {is_active: false, deactivated_at: new Date()},
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
          summary,
        },
      });

      // 결정 K: id 있고 텍스트 동일 → 기존 row 재사용. 그 외(텍스트 수정/신규)는 새 row 생성(in-place UPDATE 없음)
      const toEmbed = contents
        .map((c, idx) => ({idx, text: c.text, old: c.id ? existingById.get(c.id) : undefined}))
        .filter(c => !c.old || c.old.content !== c.text);
      const embeddings = toEmbed.length > 0
        ? await this.modelService.embedTexts(toEmbed.map(t => t.text), 'search_document: ')
        : [];
      const embeddingByIdx = new Map(toEmbed.map((t, k) => [t.idx, embeddings[k]]));

      let seq = 0;
      for (let i = 0; i < contents.length; i++) {
        const c = contents[i];
        const old = c.id ? existingById.get(c.id) : undefined;
        if (old && old.content === c.text) {
          await tx.memory__memory_content.create({data: {memory_id: newMemory.id, memory_content_id: old.id, seq: seq++}});
          continue;
        }
        const mc = await tx.memory_content.create({
          data: {
            content: c.text,
            importance: old?.importance ?? 0, durability: old?.durability ?? 0,
            reusefulness: old?.reusefulness ?? 0, sensitivity: old?.sensitivity ?? 0,
            explicit_signal: old?.explicit_signal ?? 0, llm_confidence_hint: old?.llm_confidence_hint ?? 0,
            repetition_count: old?.repetition_count ?? 0, confirmed_score: old?.confirmed_score ?? 0,
            score: old?.score ?? 0,
          },
        });
        const emb = embeddingByIdx.get(i);
        if (emb) await tx.$executeRaw`UPDATE memory_content SET embedding = ${`[${emb.join(',')}]`}::vector WHERE id = ${mc.id}::uuid`;
        await tx.memory__memory_content.create({data: {memory_id: newMemory.id, memory_content_id: mc.id, seq: seq++}});
      }

      // keyword는 편집 대상이 아니므로 기존 값 그대로 복사 (안 하면 Spec2에서 고친 것과 같은 유실 버그 재발)
      await tx.$executeRaw`
          INSERT INTO memory__keyword (memory_id, keyword_code, weight)
          SELECT ${newMemory.id}::uuid, keyword_code, weight
          FROM memory__keyword
          WHERE memory_id = ${existing.id}::uuid
          ON CONFLICT DO NOTHING
      `;

      const allEmb = await tx.$queryRaw<{ embedding: number[] }[]>`
          SELECT embedding::float4[] AS embedding
          FROM memory_content mc
                   JOIN memory__memory_content mmc ON mmc.memory_content_id = mc.id
          WHERE mmc.memory_id = ${newMemory.id}::uuid
          AND mc.embedding IS NOT NULL
      `;
      if (allEmb.length > 0) {
        const centroid = this.modelService.getAverageCentroid(allEmb.map(r => r.embedding));
        await tx.$executeRaw`UPDATE memory SET embedding = ${`[${centroid.join(',')}]`}::vector WHERE id = ${newMemory.id}::uuid`;
      }

      return newMemory;
    });
  }

  async importKnowledgeMemory(userId: string, analysis: LlmMemoryAnalysis) {
    const maxClusterSize = Number(this.config.get('MAX_CLUSTER_SIZE', 50));
    const clusterSizeScore = Math.min(1, Math.log(2) / Math.log(1 + maxClusterSize)); // cluster_size = 1 (단일 메시지 케이스와 동일 취급)
    const recencyDecayFactor = Number(this.config.get('RECENCY_DECAY_FACTOR', 30));
    const repetitionNormCap = Number(this.config.get('REPETITION_NORM_CAP', 10));
    const now = new Date();

    const embeddings = analysis.contents.length > 0
      ? await this.modelService.embedTexts(analysis.contents.map(c => c.text), 'search_document: ')
      : [];

    return this.prisma.$transaction(async (tx) => {
      const newMemory = await tx.memory.create({
        data: {
          user_id: userId,
          type: 'knowledge',
          history_type: 'uploaded',
          version: 1,
          summary: analysis.summary,
        },
      });

      let seq = 0;
      for (let i = 0; i < analysis.contents.length; i++) {
        const content = analysis.contents[i];
        const importance = clamp(clamp(content.importance) + 0.15 * clusterSizeScore);
        const {confirmedScore, score} = computeScore({
          importance,
          durability: clamp(content.durability),
          reusefulness: clamp(content.reusefulness),
          explicit_signal: clamp(content.explicit_signal),
          repetition_count: 0,
          llm_confidence_hint: clamp(content.llm_confidence_hint),
          sensitivity: clamp(content.sensitivity),
          last_referenced_at: null,
          created_at: now,
        }, recencyDecayFactor, repetitionNormCap);

        const mc = await tx.memory_content.create({
          data: {
            content: content.text, importance, durability: clamp(content.durability),
            reusefulness: clamp(content.reusefulness), sensitivity: clamp(content.sensitivity),
            explicit_signal: clamp(content.explicit_signal), llm_confidence_hint: clamp(content.llm_confidence_hint),
            confirmed_score: confirmedScore, score, scored_at: now,
          },
        });
        await tx.$executeRaw`UPDATE memory_content SET embedding = ${`[${embeddings[i].join(',')}]`}::vector WHERE id = ${mc.id}::uuid`;
        await tx.memory__memory_content.create({data: {memory_id: newMemory.id, memory_content_id: mc.id, seq: seq++}});
        // 결정 C: message 근거 연결 없음
      }

      const normalizedKeywords = (analysis.keywords ?? [])
        .map(k => ({...k, code: k.code?.toLowerCase().replace(/_/g, '-')}))
        .filter(k => k.code && /^[a-z0-9-]+$/.test(k.code));

      for (const kw of normalizedKeywords) {
        await tx.$executeRaw`
            INSERT INTO keyword (code, name)
            VALUES (${kw.code}, ${kw.name}) ON CONFLICT (code) DO NOTHING
        `;
        await tx.$executeRaw`
            INSERT INTO memory__keyword (memory_id, keyword_code, weight)
            VALUES (${newMemory.id}::uuid, ${kw.code}, ${kw.weight ?? 1}) ON CONFLICT DO NOTHING
        `;
      }

      if (embeddings.length > 0) {
        const centroid = this.modelService.getAverageCentroid(embeddings);
        await tx.$executeRaw`
            UPDATE memory
            SET embedding = ${`[${centroid.join(',')}]`}::vector
            WHERE id = ${newMemory.id}::uuid
        `;
      }

      return newMemory;
    });
  }

  async findForgettingCandidates(scoreThreshold: number, staleDays: number) {
    return this.prisma.$queryRaw<{ user_id: string; id: string }[]>`
        SELECT DISTINCT m.user_id, m.id
        FROM memory m
                 JOIN memory__memory_content mmc ON mmc.memory_id = m.id
                 JOIN memory_content mc ON mc.id = mmc.memory_content_id
        WHERE m.type = 'knowledge'
          AND m.is_active = true
          AND m.deleted_at IS NULL
          AND m.is_pinned = false
          AND mc.score < ${scoreThreshold}
          AND COALESCE(mc.last_referenced_at, mc.created_at) < NOW() - (${staleDays} || ' days')::interval
    `;
  }

  // 결정 F/7번: 삭제가 아니라 "새 문장 없이 carry만 하는 saveMemory 호출"로 forgotten content를 새 버전 조인에서 뺌
  async applyForgettingToMemory(userId: string, memoryId: string) {
    const existing = await this.prisma.memory.findFirst({
      where: {id: memoryId, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null},
      select: {id: true, version: true, root_memory_id: true},
    });
    if (!existing) return;

    await this.prisma.$transaction(async (tx) => {
      await this.saveMemory(tx, userId, {
        messageIds: [],
        analysis: {keywords: [], contents: [], summary: ''},
        existingMemory: existing,
      });
    });
  }

  async deleteKnowledgeMemory(userId: string, id: string) {
    const target = await this.prisma.memory.findFirst({
      where: {id, user_id: userId, type: 'knowledge', deleted_at: null},
      select: {id: true, root_memory_id: true},
    });
    if (!target) return null;
    const rootId = target.root_memory_id ?? target.id;

    const versionIds = (await this.prisma.memory.findMany({
      where: {user_id: userId, type: 'knowledge', OR: [{id: rootId}, {root_memory_id: rootId}]},
      select: {id: true},
    })).map(v => v.id);

    await this.prisma.$transaction(async (tx) => {
      // 이 lineage 밖(versionIds 외)에는 조인이 하나도 안 남는 content만 실제 삭제
      await tx.$executeRaw`
          DELETE FROM memory_content__message WHERE memory_content_id IN (
              SELECT mmc.memory_content_id FROM memory__memory_content mmc
              WHERE mmc.memory_id = ANY (${versionIds}::uuid[])
                AND NOT EXISTS (
                  SELECT 1 FROM memory__memory_content other
                  WHERE other.memory_content_id = mmc.memory_content_id
                    AND other.memory_id <> ALL (${versionIds}::uuid[])
                )
          )
      `;
      await tx.$executeRaw`
          DELETE FROM memory_content WHERE id IN (
              SELECT mmc.memory_content_id FROM memory__memory_content mmc
              WHERE mmc.memory_id = ANY (${versionIds}::uuid[])
                AND NOT EXISTS (
                  SELECT 1 FROM memory__memory_content other
                  WHERE other.memory_content_id = mmc.memory_content_id
                    AND other.memory_id <> ALL (${versionIds}::uuid[])
                )
          )
      `;
      await tx.memory__memory_content.deleteMany({where: {memory_id: {in: versionIds}}});
      await tx.memory__keyword.deleteMany({where: {memory_id: {in: versionIds}}});
      await tx.memory.updateMany({
        where: {id: {in: versionIds}},
        data: {deleted_at: new Date(), is_active: false, deactivated_at: new Date()},
      });

      // memory_content__message는 N:M이라 message 하나가 다른(삭제 대상 아닌) memory의
      // 근거로 여전히 쓰이고 있을 수 있음 — 완전히 퇴출된 message만 root_memory_id를 null로 리셋
      const candidateIds = await this.messageRepo.findIdsByRootMemoryId(tx, rootId);
      const stillReferenced = new Set(
        (await tx.memory_content__message.findMany({
          where: {message_id: {in: candidateIds}},
          select: {message_id: true},
          distinct: ['message_id'],
        })).map(r => r.message_id),
      );
      const toReset = candidateIds.filter(mid => !stillReferenced.has(mid));

      await this.messageRepo.resetRootMemoryId(tx, toReset);
    });

    return {id: target.id};
  }

  async applyDecay() {
    const recencyDecayFactor = Number(this.config.get('RECENCY_DECAY_FACTOR', 30));
    const repetitionNormCap = Number(this.config.get('REPETITION_NORM_CAP', 10));
    const contents = await this.prisma.memory_content.findMany({
      where: {memory_versions: {some: {memory: {type: 'knowledge', is_active: true, deleted_at: null}}}},
    });
    for (const c of contents) {
      const {confirmedScore, score} = computeScore(c, recencyDecayFactor, repetitionNormCap);
      await this.prisma.memory_content.update({
        where: {id: c.id},
        data: {confirmed_score: confirmedScore, score, scored_at: new Date()},
      });
    }
  }

  async saveMainMemory(
    userId: string,
    contents: string[],
    existing: { id: string; version: number } | null,
    historyType: 'renewed' | 'modified' = 'renewed',
  ) {
    const now = new Date();
    if (existing) {
      await this.prisma.memory.update({
        where: {id: existing.id},
        data: {is_active: false, deactivated_at: now},
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const newMemory = await tx.memory.create({
        data: {
          user_id: userId,
          type: 'main',
          history_type: historyType,
          version: existing ? existing.version + 1 : 1,
          parent_memory_id: existing?.id ?? null,
          root_memory_id: null,
        },
      });
      for (const [seq, content] of contents.entries()) {
        const mc = await tx.memory_content.create({data: {content}});
        await tx.memory__memory_content.create({data: {memory_id: newMemory.id, memory_content_id: mc.id, seq}});
      }
      return newMemory;
    });
  }

  async findContentMessages(userId: string, contentId: string) {
    return this.prisma.$queryRaw<{
      id: string;
      role: string;
      provider: string | null;
      content: string;
      created_at: Date
    }[]>`
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
        WITH query_embeddings AS (SELECT ordinality - 1 AS content_idx,
                                         embedding      AS query_embedding
                                  FROM unnest(ARRAY[${embArrayLiteral}]) WITH ORDINALITY AS t(embedding, ordinality)),
             scored AS (SELECT qe.content_idx,
                               mc.message_id,
                               1 - (mc.embedding <=> qe.query_embedding) AS similarity,
                               ROW_NUMBER()                                 OVER (
            PARTITION BY qe.content_idx, mc.message_id
            ORDER BY mc.embedding <=> qe.query_embedding
          ) AS rn
                        FROM query_embeddings qe
                                 CROSS JOIN message_content mc
                        WHERE mc.message_id = ANY (ARRAY[${messageIdList}])),
             top2 AS (SELECT content_idx,
                             message_id,
                             MAX(CASE WHEN rn = 1 THEN similarity END) AS top1,
                             MAX(CASE WHEN rn = 2 THEN similarity END) AS top2
                      FROM scored
                      WHERE rn <= 2
                      GROUP BY content_idx, message_id)
        SELECT content_idx,
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
        WITH query_embeddings AS (SELECT ordinality - 1 AS content_idx,
                                         embedding      AS query_embedding
                                  FROM unnest(ARRAY[${embArrayLiteral}]) WITH ORDINALITY AS t(embedding, ordinality)),
             scored AS (SELECT qe.content_idx,
                               mc.message_id,
                               1 - (mc.embedding <=> qe.query_embedding) AS similarity,
                               ROW_NUMBER()                                 OVER (
            PARTITION BY qe.content_idx, mc.message_id
            ORDER BY mc.embedding <=> qe.query_embedding
          ) AS rn
                        FROM query_embeddings qe
                                 CROSS JOIN message_content mc
                        WHERE mc.message_id = ANY (ARRAY[${messageIdList}])),
             top2 AS (SELECT content_idx,
                             message_id,
                             MAX(CASE WHEN rn = 1 THEN similarity END) AS top1,
                             MAX(CASE WHEN rn = 2 THEN similarity END) AS top2
                      FROM scored
                      WHERE rn <= 2
                      GROUP BY content_idx, message_id)
        SELECT content_idx,
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
