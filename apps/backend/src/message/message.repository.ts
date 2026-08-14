import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class MessageRepository {
  constructor(private prisma: PrismaService) {}

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
    return this.prisma.message.create({ data });
  }

  async updateMessageEmbedding(messageId: string, vec: number[]) {
    return this.prisma.$executeRaw`
      UPDATE message SET embedding = ${`[${vec.join(',')}]`}::vector WHERE id = ${messageId}::uuid
    `;
  }

  async insertMessageContents(messageId: string, sentences: { seq: number; content: string; embedding: number[] }[]) {
    await Promise.all(
      sentences.map(s => this.prisma.$executeRaw`
        INSERT INTO message_content (id, message_id, seq, content, embedding)
        VALUES (gen_random_uuid(), ${messageId}::uuid, ${s.seq}, ${s.content}, ${`[${s.embedding.join(',')}]`}::vector)
      `),
    );
  }

  async findRecentMessages(userId: string, take: number) {
    return this.prisma.message.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take,
    });
  }

  async findHistory(userId: string) {
    return this.prisma.message.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      include: { provider_code: true, model_code: true },
    });
  }

  async findAssistantMessagesWithoutContent() {
    return this.prisma.message.findMany({
      where: {
        role: 'assistant',
        parent_message_id: { not: null },
        message_contents: { none: {} },
      },
      include: { parent_message: true },
    });
  }

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
      this.prisma.$queryRaw<{ message_id: string; content: string; embedding: number[] }[]>`
        SELECT message_id, content, embedding::float4[] AS embedding
        FROM message_content
        WHERE message_id = ANY(${assistantIds}::uuid[])
        ORDER BY message_id, seq ASC
      `,
    ]);

    const userById = new Map(userRows.map(m => [m.id, m]));
    const contentTextByMsgId = new Map<string, string[]>();
    const contentEmbeddingsByMsgId = new Map<string, number[][]>();
    for (const row of contentRows) {
      if (!contentTextByMsgId.has(row.message_id)) contentTextByMsgId.set(row.message_id, []);
      contentTextByMsgId.get(row.message_id)!.push(row.content);
      if (!contentEmbeddingsByMsgId.has(row.message_id)) contentEmbeddingsByMsgId.set(row.message_id, []);
      contentEmbeddingsByMsgId.get(row.message_id)!.push(row.embedding);
    }

    return assistantRows.map(aMsg => {
      const messages: MessageForBatch[] = [];
      if (aMsg.parent_message_id) {
        const parent = userById.get(aMsg.parent_message_id);
        if (parent) messages.push(parent);
      }
      const content = (contentTextByMsgId.get(aMsg.id) ?? [aMsg.content]).join(' ');
      messages.push({ id: aMsg.id, role: aMsg.role, provider: aMsg.provider, content, terms: aMsg.terms });
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

  async findMemoryMessages(rootId: string): Promise<MessageForBatch[]> {
    return this.prisma.$queryRaw<MessageForBatch[]>`
      SELECT id, role, provider, content, terms
      FROM message
      WHERE root_memory_id = ${rootId}::uuid
      ORDER BY created_at ASC
    `;
  }

  async markProceeded(messageIds: string[]) {
    await this.prisma.message.updateMany({
      where: { id: { in: messageIds } },
      data: { is_proceeded: true },
    });
  }

  async markProceededTx(tx: Prisma.TransactionClient, messageIds: string[]) {
    await tx.message.updateMany({
      where: { id: { in: messageIds } },
      data: { is_proceeded: true },
    });
  }

  async updateRootMemoryId(tx: Prisma.TransactionClient, messageIds: string[], rootMemoryId: string) {
    await tx.message.updateMany({
      where: { id: { in: messageIds } },
      data: { root_memory_id: rootMemoryId },
    });
  }

  async findIdsByRootMemoryId(tx: Prisma.TransactionClient, rootId: string): Promise<string[]> {
    const rows = await tx.message.findMany({ where: { root_memory_id: rootId }, select: { id: true } });
    return rows.map(r => r.id);
  }

  async resetRootMemoryId(tx: Prisma.TransactionClient, messageIds: string[]) {
    await tx.message.updateMany({ where: { id: { in: messageIds } }, data: { root_memory_id: null } });
  }
}
