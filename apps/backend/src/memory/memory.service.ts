import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MemoryService {
  constructor(private prisma: PrismaService) {}

  async getActiveMainMemory(userId: string): Promise<string | null> {
    const row = await this.prisma.memory.findFirst({
      where: { user_id: userId, type: 'main', is_active: true },
      select: { summary: true },
    });
    return row?.summary ?? null;
  }

  async getTopKnowledge(
    userId: string,
    embedding: number[],
    topK: number,
  ): Promise<{ id: string; summary: string }[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; summary: string }[]>`
      SELECT id, summary
      FROM memory
      WHERE user_id = ${userId}::uuid
        AND type = 'knowledge'
        AND is_active = true
        AND embedding IS NOT NULL
        AND summary IS NOT NULL
      ORDER BY embedding <=> ${embedding}::vector
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
    const memories = await this.prisma.memory.findMany({
      where: { user_id: userId, type: 'knowledge', is_active: true },
      orderBy: { created_at: 'desc' },
      include: {
        keywords: { include: { keyword: true } },
      },
    });

    return memories.map(m => ({
      id: m.id,
      keywords: m.keywords.map(mk => ({ code: mk.keyword_code, name: mk.keyword.name })),
      version: m.version,
      isPinned: m.is_pinned,
      createdAt: m.created_at,
    }));
  }
}
