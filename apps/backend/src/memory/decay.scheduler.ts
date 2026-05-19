import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DecayScheduler {
  constructor(private prisma: PrismaService) {}

  @Cron('0 0 * * *')
  async applyDecay() {
    await this.prisma.$executeRaw`
      UPDATE memory
      SET repetition_strength = GREATEST(0, LEAST(1, repetition_strength * 0.995))
      WHERE type = 'knowledge' AND is_active = true
    `;
  }
}
