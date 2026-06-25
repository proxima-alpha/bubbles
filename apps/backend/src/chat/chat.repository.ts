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
    summary?: string | null;
    provider?: string;
    model?: string;
    input_tokens?: number | null;
    output_tokens?: number | null;
    parent_message_id?: string;
  }) {
    return this.prisma.message.create({ data });
  }

  async updateMessageSummaryAndEmbedding(messageId: string, summary: string, vec: number[]) {
    return this.prisma.$executeRaw`
      UPDATE message SET summary = ${summary}, embedding = ${`[${vec.join(',')}]`}::vector WHERE id = ${messageId}::uuid
    `;
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
