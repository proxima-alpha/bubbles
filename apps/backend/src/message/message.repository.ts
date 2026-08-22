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
  message_content: string;
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
    return this.prisma.message.findMany({
      where: {user_id: userId},
      orderBy: {created_at: 'desc'},
      take,
    });
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
        SELECT m.id        AS message_id,
               m.role,
               m.provider,
               m.terms,
               m.parent_message_id,
               m.content   AS message_content,
               mc.content,
               mc.weight
        FROM message_content mc
                 JOIN message m ON m.id = mc.message_id
        WHERE m.user_id = ${userId}::uuid
        AND m.is_proceeded = false
        ORDER BY m.created_at ASC, mc.seq ASC
    `;

    // const assistantOrder: string[] = [];
    // const assistantById = new Map<string, {
    //   role: string;
    //   provider: string | null;
    //   terms: string[];
    //   parent_message_id: string | null
    // }>();
    // const contentsByMsgId = new Map<string, { content: string; embedding: number[]; weight: number }[]>();
    // for (const row of contentRows) {
    //   if (!assistantById.has(row.message_id)) {
    //     assistantOrder.push(row.message_id);
    //     assistantById.set(row.message_id, {
    //       role: row.role,
    //       provider: row.provider,
    //       terms: row.terms,
    //       parent_message_id: row.parent_message_id
    //     });
    //     contentsByMsgId.set(row.message_id, []);
    //   }
    //   contentsByMsgId.get(row.message_id)!.push({content: row.content, embedding: row.embedding, weight: row.weight});
    // }
    //
    // const parentIds = [...assistantById.values()].map(m => m.parent_message_id).filter((id): id is string => id !== null);
    // const userRows = parentIds.length > 0
    //   ? await this.prisma.$queryRaw<MessageForBatch[]>`
    //             SELECT id, role, provider, content, terms
    //             FROM message
    //             WHERE id = ANY (${parentIds}::uuid[])
    //               AND is_proceeded = false
    //   `
    //   : [];
    // const userById = new Map(userRows.map(m => [m.id, m]));
    //
    // return assistantOrder.map(id => {
    //     const aMsg = assistantById.get(id)!;
    //     const messages: MessageForBatch[] = [];
    //     if (aMsg.parent_message_id) {
    //       const parent = userById.get(aMsg.parent_message_id);
    //       if (parent) messages.push(parent);
    //     }
    //     const contents = contentsByMsgId.get(id)!;
    //     const content = contents.map(c => c.content).join('\n');
    //     messages.push({id, role: aMsg.role, provider: aMsg.provider, content, terms: aMsg.terms});
    //     return {
    //       id,
    //       messages,
    //       contentEmbeddings: contents.map(c => c.embedding),
    //       contentWeights: contents.map(c => c.weight),
    //     };
    //   }
    // );
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
               m.content   AS message_content,
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
