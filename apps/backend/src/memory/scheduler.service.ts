import {Injectable} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '../prisma/prisma.service';
import {ModelService} from '../model/model.service';
import {SystemChatService} from '../model/system-chat.service';
import {BatchMemoryResult, MemoryRepository, SaveArgs} from './memory.repository';
import {Exchange, MessageForBatch, MessageRepository} from '../message/message.repository';
import {UserRepository} from '../user/user.repository';

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

  async executeMemorization(userId: string): Promise<BatchMemoryResult[]> {
    const exchanges = await this.messageRepo.findUnprocessedExchanges(userId);
    if (exchanges.length === 0) return [];

    const rawGroups: GroupArgs[] = [];

    if (exchanges.length <= 1) {
      for (const exchange of exchanges) {
        rawGroups.push(await this.prepareGroup(userId, [exchange]));
      }
    } else {
      const exchangeTexts = exchanges.map(e => e.messages.map(m => m.content).join('\n'));
      const vectors = await this.modelService.embedTexts(exchangeTexts, 'clustering: ');
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
    const skippedMessageIds: string[] = [];
    for (const group of groups) {
      const existingMessages = group.existingMemory
        ? await this.messageRepo.findMemoryMessages(group.existingMemory.root_memory_id ?? group.existingMemory.id)
        : undefined;
      const analysis = await this.systemChatService.analyzeConversation(userId, group.messages, group.existingMemory?.content ?? undefined);
      if (analysis.contents.length > 0) {
        const associationMessages = existingMessages ? [...existingMessages, ...group.messages] : group.messages;
        const associations = await this.runAssociationMapping(analysis.contents, associationMessages);
        pendingSaves.push({...group, analysis: {...analysis, associations}});
      } else {
        skippedMessageIds.push(...group.messages.map(m => m.id));
      }
    }

    if (skippedMessageIds.length > 0) {
      await this.messageRepo.markProceeded(skippedMessageIds);
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
    const mergeMaxSimilarity = Number(this.config.get('MERGE_MAX_SIMILARITY', 0.9));

    const messages = exchanges.flatMap(e => e.messages);
    const content = await this.systemChatService.generateMessageContents(userId, messages);
    if (content.length === 0) {
      return {messages, memCentroid: [], existingMemory: null};
    }

    const contentEmbeddings = await this.modelService.embedTextsChunked(content, 'search_query: ');
    const clusterCentroid = centroid(contentEmbeddings);

    // await this.memoryRepo.logSimilarMemory(userId, clusterCentroid);
    const existingMemory = await this.memoryRepo.findSimilarMemory(userId, clusterCentroid, mergeMaxSimilarity);
    let isMerge = existingMemory !== null;
    if (isMerge) {
      const existingMessages = await this.messageRepo.findMemoryMessages(
        existingMemory!.root_memory_id ?? existingMemory!.id,
      );
      if (existingMessages.length === 0) isMerge = false;
    }

    return {
      messages,
      memCentroid: clusterCentroid,
      existingMemory: isMerge ? existingMemory : null,
    };
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
