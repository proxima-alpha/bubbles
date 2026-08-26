import {Injectable} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '../prisma/prisma.service';
import {ModelService} from '../model/model.service';
import {SystemChatService} from '../model/system-chat.service';
import {BatchMemoryResult, MemoryRepository, SaveArgs} from './memory.repository';
import {ExchangeRow, MessageRepository} from '../message/message.repository';
import {UserRepository} from '../user/user.repository';

interface ExchangeGroup {
  exchanges: Exchange[][];
  centroid: number[];
  existingMemory: { id: string; version: number; root_memory_id: string | null; content: string | null } | null;
}

export interface Exchange extends ExchangeRow {
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

  async parseRowsToExchange(rows: ExchangeRow[]): Promise<Map<string, ExchangeRow[]>> {
    const exchanges = new Map<string, ExchangeRow[]>(
      rows.filter(row => row.role === 'user').map(row => [row.message_id, [row]])
    );

    rows.filter(row => !!row.parent_message_id).forEach(row => {
      if (!row.parent_message_id) {
        return
      }
      exchanges.get(row.parent_message_id)?.push(row);
    })
    return exchanges
  }

  async executeMemorization(userId: string): Promise<BatchMemoryResult[]> {
    const rows = await this.messageRepo.findUnprocessedExchanges(userId);

    const embeddings = await this.modelService.embedTexts(rows.map(row => row.content), 'clustering: ');
    const embeddedRows = rows.map((row, index) => ({...row, embedding: embeddings[index]}))

    const exchanges = await this.parseRowsToExchange(embeddedRows) as Map<string, Exchange[]>
    if (exchanges.size === 0) return [];

    let groups: ExchangeGroup[] = [];

    if (exchanges.size <= 1) {
      for (const [_, exchange] of exchanges) {
        groups.push(await this.checkMessageFromMemory(userId, [exchange]));
      }
    } else {
      const ids: string[] = [];
      const vectors: number[][] = [];

      for (const [id, exchange] of exchanges) {
        ids.push(id);
        const primeExchanges = exchange.filter(e => e.weight >= 0.8)
        vectors.push(this.modelService.getWeightedCentroid(primeExchanges.map(e => e.embedding), primeExchanges.map(e => e.weight)));
        // vectors.push(this.modelService.getAverageCentroid(primeExchanges.map(e => e.embedding)));
        // const mainExchange = exchange.filter(e => e.role !== 'user').sort((a, b) => b.weight - a.weight).at(0);
        // if (mainExchange) {
        //   ids.push(id);
        //   vectors.push(mainExchange.embedding);
        // }
      }

      const clusterResult = await this.runClustering(vectors, ids);

      groups.push(...await Promise.all(
        clusterResult.clusters.map((cluster: { label: number; ids: string[] }) =>
          this.checkMessageFromMemory(userId, cluster.ids.map((id: string) => exchanges.get(id)!)),
        ),
      ));

      for (const noiseId of clusterResult.noise) {
        if (exchanges.has(noiseId)) {
          groups.push(await this.checkMessageFromMemory(userId, [exchanges.get(noiseId)!]));
        }
      }
    }

    groups = this.consolidateByTarget(groups);

    const pendingSaves: SaveArgs[] = [];
    const skippedMessageIds: string[] = [];
    for (const group of groups) {
      const existingMessages = group.existingMemory
        ? await this.messageRepo.findMemoryMessages(group.existingMemory.root_memory_id ?? group.existingMemory.id)
        : [];
      const analysis = await this.systemChatService.analyzeConversation(userId, group.exchanges, group.existingMemory?.content ?? undefined);
      if (analysis.contents.length > 0) {
        const allAssistantMessageIds = [...new Set([...existingMessages, ...group.exchanges.flat()].filter(e => e.role != 'user').map(row => row.message_id))];
        const allMessageIds = [...new Set([...existingMessages, ...group.exchanges.flat()].map(row => row.message_id))];
        const associations = await this.findAssociations(analysis.contents, allAssistantMessageIds);
        pendingSaves.push({...group, analysis: {...analysis, associations}, messageIds: allMessageIds});
      } else {
        skippedMessageIds.push(...group.exchanges.flat().map(e => e.message_id));
      }
    }

    if (skippedMessageIds.length > 0) {
      await this.messageRepo.markProceeded(skippedMessageIds);
    }

    const allEmbeddings = [...exchanges.values()].flat().map(e => e.embedding);
    return this.prisma.$transaction(async (tx) => {
      const batchResults: BatchMemoryResult[] = [];
      for (const args of pendingSaves) {
        batchResults.push(await this.memoryRepo.saveMemory(tx, userId, args));
      }
      await this.memoryRepo.updateRepetitionStrength(tx, userId, allEmbeddings, batchResults.map(r => r.id));
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
        centroid: this.modelService.getAverageCentroid(sameTarget.map(g => g.centroid)),
        existingMemory: sameTarget[0].existingMemory,
      });
    }
    return merged;
  }

  private async checkMessageFromMemory(userId: string, exchanges: Exchange[][]): Promise<ExchangeGroup> {
    const mergeMaxSimilarity = Number(this.config.get('MERGE_MAX_SIMILARITY', 0.9));

    const labels = await this.systemChatService.generateMessageContents(userId, exchanges);

    // findSimilarMemory 쿼리용 — 저장된 memory.embedding(search_document)에 대응하는 쿼리 벡터
    const queryEmbeddings = await this.modelService.embedTexts(labels.map(l => l.text), 'search_query: ');
    const queryCentroid = this.modelService.getWeightedCentroid(queryEmbeddings, labels.map(l => l.weight));

    // await this.memoryRepo.logSimilarMemory(userId, clusterCentroid);
    const existingMemory = await this.memoryRepo.findSimilarMemory(userId, queryCentroid, mergeMaxSimilarity);
    let isMerge = existingMemory !== null;
    if (isMerge) {
      const existingMessages = await this.messageRepo.findMemoryMessages(
        existingMemory!.root_memory_id ?? existingMemory!.id,
      );
      if (existingMessages.length === 0) isMerge = false;
    }

    // memory.embedding으로 저장될 값 — search_document
    const contentEmbeddings = await this.modelService.embedTexts(labels.map(l => l.text), 'search_document: ');
    const centroid = this.modelService.getWeightedCentroid(contentEmbeddings, labels.map(l => l.weight));

    return {
      exchanges: exchanges,
      centroid: centroid,
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

  // private async findAssociations(
  //   exchangeMap: Map<string, ExchangeRow[]>,
  //   prefix: string = 'search_query: ',
  // ): Promise<string[][]> {
  //   const embeddingMap: Map<string, number[]> = new Map();
  //
  //   for(const [parent_message_id, exchanges] of exchangeMap) {
  //     const messageContent = exchanges.map((message) => {message.content}).join('\n');
  //     const embeddings = await this.modelService.embedText(messageContent, prefix);
  //     embeddingMap.set(parent_message_id, embeddings)
  //   }
  //   // message_content에 이미 저장된 embedding과 DB에서 직접 vector 비교 (로컬 재계산 없이 재사용)
  //   return this.memoryRepo.findAssociations(embeddingMap);
  // }

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
    if (!res.ok) throw new Error(`Clustering error: ${res.status}`);
    return res.json();
  }

  async updateMainMemory(userId: string) {
    const scoreThreshold = Number(this.config.get('PROMOTION_SCORE_THRESHOLD', 0.6));
    const sensitivityThreshold = Number(this.config.get('PROMOTION_SENSITIVITY_THRESHOLD', 0.6));

    const promoted = await this.memoryRepo.findPromotedMemories(userId, scoreThreshold, sensitivityThreshold);
    if (promoted.length === 0) return;

    const existing = await this.memoryRepo.findMainMemory(userId);

    const newKnowledges = promoted.filter(m => m.summary).map(m => m.summary ?? '');

    if (!existing) {
      await this.memoryRepo.saveMainMemory(userId, newKnowledges.join("\n"), existing);
    } else {
      const mainSummary = await this.systemChatService.synthesizeMainMemory(userId, existing.summary, newKnowledges);

      await this.memoryRepo.saveMainMemory(userId, mainSummary.join("\n"), existing);
    }
  }
}
