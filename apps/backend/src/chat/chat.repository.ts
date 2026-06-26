import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatRepository {
  constructor(private prisma: PrismaService) {}

  async findUserById(userId: string) {
    return this.prisma.user.findUnique({ where: { id: userId } });
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
}
