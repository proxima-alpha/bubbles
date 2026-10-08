import {Injectable} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '../prisma/prisma.service';
import {ModelService} from '../model/model.service';
import {SystemChatService} from '../model/system-chat.service';
import {BatchMemoryResult, MemoryRepository, MemoryResult, SaveArgs} from './memory.repository';
import {MessageExchangeRow, MessageRepository} from '../message/message.repository';
import {UserRepository} from '../user/user.repository';

interface ExchangeGroup {
  exchanges: Exchange[];
  existingMemory: { id: string; version: number; root_memory_id: string | null } | null;
}

export interface Exchange extends MessageExchangeRow {
  embedding: number[];
}

@Injectable()
export class SchedulerService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private modelService: ModelService,
    private systemChatService: SystemChatService,
    private memoryRepo: MemoryRepository,
    private messageRepo: MessageRepository,
    private userRepo: UserRepository,
  ) {
  }

  @Cron('* * * * *')
  async checkAndRun() {
    const threshold = Number(this.config.get('SCHEDULER_MESSAGE_THRESHOLD', 5));
    const intervalHours = Number(this.config.get('SCHEDULER_BATCH_INTERVAL_HOURS', 24));

    const overThreshold = await this.messageRepo.findUsersOverThreshold(threshold);
    const overInterval = await this.userRepo.findUsersOverInterval(intervalHours);

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

  async parseRowsToExchange(rows: Exchange[]): Promise<Exchange[]> {
    return rows.filter(row => !!row.parent_message_id).map(row => ({
      ...row,
      parent: rows.find(r => r.message_id === row.parent_message_id),
    }))
  }

  async embedTopicLabels(rows: MessageExchangeRow[]): Promise<Exchange[]> {
    const ids: string[] = [];
    const labels: string[] = [];
    const weights: number[] = []
    rows.map(row => {
      ids.push(row.message_id);
      labels.push(...row.domain, ...row.entity, ...row.action);
      weights.push(...[
        ...Array.from({length: row.domain.length}, () => 0.6),
        ...Array.from({length: row.entity.length}, () => 0.3),
        ...Array.from({length: row.action.length}, () => 0.1)
      ])
    })

    const embeddings = await this.modelService.embedTexts(labels, 'clustering: ');

    const embeddingMap: Map<string, number[][]> = new Map();
    embeddings.forEach((value, index) => {
      const key = ids[index];
      if (embeddingMap.has(key)) {
        embeddingMap.get(key)?.push(value)
      } else {
        embeddingMap.set(key, [value])
      }
    })

    const centroidEmbeddingMap = new Map([...embeddingMap.entries()].map(([key, value]) => [key, this.modelService.getAverageCentroid(value)]));
    const result = rows.map(row => ({...row, embedding: centroidEmbeddingMap.get(row.message_id)} as Exchange));

    return result;
  }

  async executeMemorization(userId: string): Promise<BatchMemoryResult[]> {
    const rows = await this.messageRepo.findUnprocessedMessage(userId);

    const embeddedRows = await this.embedTopicLabels(rows)

    const exchanges = await this.parseRowsToExchange(embeddedRows);
    if (exchanges.length === 0) return [];

    let groups: ExchangeGroup[] = [];
    const skippedMessageIds: string[] = [];

    if (exchanges.length <= 1) {
      for (const exchange of exchanges) {
        if (!!exchange.embedding) {
          groups.push(await this.checkMessageFromMemory(userId, [exchange]));
        } else {
          skippedMessageIds.push(exchange.message_id);
          if (exchange.parent_message_id) {
            skippedMessageIds.push(exchange.parent_message_id);
          }
        }
      }
    } else {
      const ids: string[] = [];
      const vectors: number[][] = [];

      for (const exchange of exchanges) {
        if (!!exchange.embedding) {
          ids.push(exchange.message_id);
          vectors.push(exchange.embedding);
        } else {
          skippedMessageIds.push(exchange.message_id);
          if (exchange.parent_message_id) {
            skippedMessageIds.push(exchange.parent_message_id);
          }
        }
      }

      if (vectors.length > 0) {
        const clusterResult = await this.runClustering(vectors, ids);

        groups.push(...await Promise.all(
          clusterResult.clusters.map((cluster: { label: number; ids: string[] }) =>
            this.checkMessageFromMemory(userId, cluster.ids.map((id: string) => exchanges[ids.indexOf(id)])),
          ),
        ));

        for (const noiseId of clusterResult.noise) {
          groups.push(await this.checkMessageFromMemory(userId, [exchanges[ids.indexOf(noiseId)]]));
        }
      }
    }

    groups = this.consolidateByTarget(groups);

    const pendingSaves: SaveArgs[] = [];
    for (const group of groups) {
      const existingMessages = group.existingMemory
        ? await this.messageRepo.findMemoryMessages(group.existingMemory.root_memory_id ?? group.existingMemory.id)
        : [];
      const analysis = await this.systemChatService.analyzeConversation(userId, group.exchanges);
      if (analysis.contents.length > 0) {
        const allAssistantMessageIds = [...new Set([...existingMessages, ...group.exchanges.flat()].filter(e => e.role != 'user').map(row => row.message_id))];
        const allMessageIds = [...new Set([...existingMessages, ...group.exchanges.flat()].map(row => row.message_id))];
        const associations = await this.findAssociations(analysis.contents.map(c => c.text), allAssistantMessageIds);
        pendingSaves.push({...group, analysis: {...analysis, associations}, messageIds: allMessageIds});
      } else {
        skippedMessageIds.push(...group.exchanges.flat().map(e => e.message_id));
      }
    }

    if (skippedMessageIds.length > 0) {
      await this.messageRepo.markProceeded(skippedMessageIds);
    }

    return this.prisma.$transaction(async (tx) => {
      const batchResults: BatchMemoryResult[] = [];
      for (const args of pendingSaves) {
        const result = await this.memoryRepo.saveMemory(tx, userId, args);
        batchResults.push(result);
        await this.messageRepo.markProceededTx(tx, args.messageIds);
      }
      const allNewContentIds = batchResults.flatMap(r => r.newContentIds);
      await this.memoryRepo.detectRepetitions(tx, userId, allNewContentIds);
      return batchResults;
    });
  }

  private consolidateByTarget(groups: ExchangeGroup[]): ExchangeGroup[] {
    const byTarget = new Map<string, ExchangeGroup[]>();
    const noTarget: ExchangeGroup[] = [];

    for (const group of groups) {
      if (!group.existingMemory) {
        noTarget.push(group);
      } else {
        const key = group.existingMemory.id;
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key)!.push(group);
      }
    }

    const merged: ExchangeGroup[] = [...noTarget];
    for (const sameTarget of byTarget.values()) {
      merged.push({
        exchanges: sameTarget.flatMap(g => g.exchanges),
        existingMemory: sameTarget[0].existingMemory,
      });
    }
    return merged;
  }

  private async checkMessageFromMemory(userId: string, exchanges: Exchange[]): Promise<ExchangeGroup> {
    const mergeMaxSimilarity = Number(this.config.get('MERGE_MAX_SIMILARITY', 0.9));

    // findSimilarMemory 쿼리용 — 저장된 memory.embedding(search_document, saveMemory가 content 평균으로 재계산)에 대응하는 쿼리 벡터
    let existingMemory: MemoryResult | null = null;
    const topicLabels = exchanges.flatMap(e => [...e.domain, ...e.entity, ...e.action]);
    const topicWeights = exchanges.flatMap(e => [
      ...Array.from({length: e.domain.length}, () => 0.6),
      ...Array.from({length: e.entity.length}, () => 0.3),
      ...Array.from({length: e.action.length}, () => 0.1)
    ]);
    if (topicLabels.length > 0) {
      const queryEmbeddings = await this.modelService.embedTexts(topicLabels, 'search_query: ');
      const queryCentroid = this.modelService.getWeightedCentroid(queryEmbeddings, topicWeights);

      // await this.memoryRepo.logSimilarMemory(userId, clusterCentroid);
      existingMemory = await this.memoryRepo.findSimilarMemory(userId, queryCentroid, mergeMaxSimilarity);
    }
    let isMerge = existingMemory !== null;
    if (isMerge) {
      const existingMessages = await this.messageRepo.findMemoryMessages(
        existingMemory?.root_memory_id ?? existingMemory!.id,
      );
      if (existingMessages.length === 0) isMerge = false;
    }

    return {
      exchanges: exchanges,
      existingMemory: isMerge ? existingMemory : null,
    };
  }

  private async findAssociations(
    memoryContents: string[],
    messageIds: string[],
    prefix: string = 'search_query: ',
  ): Promise<string[][]> {
    if (memoryContents.length === 0) return memoryContents.map(() => []);
    const embeddings = await this.modelService.embedTexts(memoryContents, prefix);

    // message_content에 이미 저장된 embedding과 DB에서 직접 vector 비교 (로컬 재계산 없이 재사용)
    return this.memoryRepo.findAssociations(embeddings, messageIds);
  }

  private async runClustering(vectors: number[][], ids: string[]): Promise<{
    clusters: { label: number; ids: string[] }[];
    noise: string[]
  }> {
    const url = this.config.get<string>('CLUSTERING_URL', 'http://clustering:8000');
    const minClusterSize = Number(this.config.get('CLUSTERING_MIN_CLUSTER_SIZE', 2));
    const similarityThreshold = Number(this.config.get('CLUSTERING_SIMILARITY_THRESHOLD', 0.95));
    const res = await fetch(`${url}/cluster`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({vectors, ids, min_cluster_size: minClusterSize, similarity_threshold: similarityThreshold}),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Clustering error: ${res.status} ${res.statusText} - ${body}`);
    }
    return res.json();
  }

  async updateMainMemory(userId: string) {
    const scoreThreshold = Number(this.config.get('PROMOTION_SCORE_THRESHOLD', 0.6));
    const sensitivityThreshold = Number(this.config.get('PROMOTION_SENSITIVITY_THRESHOLD', 0.6));

    const promoted = await this.memoryRepo.findPromotedContents(userId, scoreThreshold, sensitivityThreshold);
    if (promoted.length === 0) return;

    const existing = await this.memoryRepo.findMainMemory(userId);

    const newKnowledges = promoted.map(c => c.content);

    if (!existing) {
      await this.memoryRepo.saveMainMemory(userId, newKnowledges, existing);
    } else {
      const existingSummary = existing.contents.map(c => c.content).join("\n");
      const mainSummary = await this.systemChatService.synthesizeMainMemory(userId, existingSummary, newKnowledges);

      await this.memoryRepo.saveMainMemory(userId, mainSummary, existing);
    }
  }
}
