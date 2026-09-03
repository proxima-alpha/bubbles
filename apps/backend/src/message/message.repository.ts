import {Injectable} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {PrismaService} from '../prisma/prisma.service';

export interface MessageForBatch {
  id: string;
  role: string;
  provider: string | null;
  content: string;
  terms: string[];
}

export interface ExchangeRow {
  role: string;
  provider: string | null;
  content: string;
  weight: number;
  message_id: string;
  parent_message_id: string | null;
  terms: string[];
}

// export interface Exchange {
//   id: string; // assistant message ID
//   messages: MessageForBatch[];
//   contentEmbeddings: number[][]; // message_content embeddings from the assistant message
//   contentWeights: number[]; // message_content weights, parallel to contentEmbeddings
// }

@Injectable()
export class MessageRepository {
  constructor(private prisma: PrismaService) {
  }

  async createMessage(data: {
    user_id: string;
    role: string;
    content: string;
    provider?: string;
    model?: string;
    input_tokens?: number | null;
    output_tokens?: number | null;
    parent_message_id?: string;
  }) {
    return this.prisma.message.create({data});
  }

  async updateMessageEmbedding(messageId: string, vec: number[]) {
    return this.prisma.$executeRaw`
        UPDATE message
        SET embedding = ${`[${vec.join(',')}]`}::vector
        WHERE id = ${messageId}::uuid
    `;
  }

  async insertMessageContents(messageId: string, sentences: {
    seq: number;
    content: string;
    embedding: number[];
    weight: number
  }[]) {
    await Promise.all(
      sentences.map(s => this.prisma.$executeRaw`
          INSERT INTO message_content (message_id, seq, content, embedding, weight)
          VALUES (${messageId}::uuid, ${s.seq}, ${s.content}, ${`[${s.embedding.join(',')}]`}::vector, ${s.weight})
      `),
    );
  }

  async findRecentMessages(userId: string, take: number) {
    return this.prisma.$queryRaw<{ id: string; role: string; content: string; created_at: Date }[]>`
        WITH recent_exchange AS (SELECT id
                                  FROM message
                                  WHERE user_id = ${userId}::uuid
                                    AND role = 'user'
                                  ORDER BY created_at DESC
                                  LIMIT ${take}),
             recent AS (SELECT m.id, m.role, m.content, m.created_at
                        FROM message m
                                 JOIN recent_exchange re ON m.id = re.id OR m.parent_message_id = re.id)
        SELECT r.id,
               r.role,
               r.created_at,
               COALESCE(string_agg(mc.content, ' ' ORDER BY mc.seq), r.content) AS content
        FROM recent r
                 LEFT JOIN message_content mc ON mc.message_id = r.id
        GROUP BY r.id, r.role, r.content, r.created_at
        ORDER BY r.created_at ASC
    `;
  }

  async findHistory(userId: string) {
    return this.prisma.message.findMany({
      where: {user_id: userId},
      orderBy: {created_at: 'desc'},
      include: {provider_code: true, model_code: true},
    });
  }

  async findAssistantMessagesWithoutContent() {
    return this.prisma.message.findMany({
      where: {
        role: 'assistant',
        parent_message_id: {not: null},
        message_contents: {none: {}},
      },
      include: {parent_message: true},
    });
  }

  findUnprocessedExchanges(userId: string): Promise<ExchangeRow[]> {
    return this.prisma.$queryRaw<ExchangeRow[]>`
        SELECT m.id                             AS message_id,
               m.role,
               m.provider,
               m.terms,
               m.parent_message_id,
               COALESCE(mc.content, m.content)   AS content,
               COALESCE(mc.weight, 1)            AS weight
        FROM message m
                 LEFT JOIN message_content mc ON mc.message_id = m.id
        WHERE m.user_id = ${userId}::uuid
          AND m.is_proceeded = false
          AND (mc.id IS NOT NULL OR m.role = 'user')
        ORDER BY m.created_at ASC, COALESCE(mc.seq, -1) ASC
    `;
  }

  async findUsersOverThreshold(threshold: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
        SELECT user_id
        FROM message m
        WHERE m.is_proceeded = false
          AND m.role != 'user'
        AND EXISTS (SELECT 1 FROM message_content mc WHERE mc.message_id = m.id)
        GROUP BY user_id
        HAVING COUNT (*) >= ${threshold}
    `;
    return rows.map(r => r.user_id);
  }

  async findMemoryMessages(rootId: string): Promise<ExchangeRow[]> {
    return this.prisma.$queryRaw<ExchangeRow[]>`
        SELECT m.id        AS message_id,
               m.role,
               m.provider,
               m.terms,
               m.parent_message_id,
               mc.content,
               mc.weight
        FROM message_content mc
                 JOIN message m ON m.id = mc.message_id
        WHERE m.root_memory_id = ${rootId}::uuid
        ORDER BY m.created_at ASC, mc.seq ASC
    `;
  }

  async markProceeded(messageIds: string[]) {
    await this.prisma.message.updateMany({
      where: {id: {in: messageIds}},
      data: {is_proceeded: true},
    });
  }

  async markProceededTx(tx: Prisma.TransactionClient, messageIds: string[]) {
    await tx.message.updateMany({
      where: {id: {in: messageIds}},
      data: {is_proceeded: true},
    });
  }

  async updateRootMemoryId(tx: Prisma.TransactionClient, messageIds: string[], rootMemoryId: string) {
    await tx.message.updateMany({
      where: {id: {in: messageIds}},
      data: {root_memory_id: rootMemoryId},
    });
  }

  async findIdsByRootMemoryId(tx: Prisma.TransactionClient, rootId: string): Promise<string[]> {
    const rows = await tx.message.findMany({where: {root_memory_id: rootId}, select: {id: true}});
    return rows.map(r => r.id);
  }

  async resetRootMemoryId(tx: Prisma.TransactionClient, messageIds: string[]) {
    await tx.message.updateMany({where: {id: {in: messageIds}}, data: {root_memory_id: null}});
  }
}
