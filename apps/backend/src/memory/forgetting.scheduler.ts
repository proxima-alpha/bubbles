import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { MemoryRepository } from './memory.repository';

@Injectable()
export class ForgettingScheduler {
  constructor(
    private memoryRepo: MemoryRepository,
    private config: ConfigService,
  ) {}

  @Cron('0 1 * * *') // decay 이후 시각대(00:00 UTC decay, 01:00 UTC forgetting)
  async applyForgetting() {
    // config.get<boolean>()도 number와 같은 문제 — env string "false"가 truthy라 !enabled가 항상 false가 됨
    if (this.config.get('FORGETTING_ENABLED', 'false') !== 'true') return;
    const threshold = Number(this.config.get('FORGETTING_SCORE_THRESHOLD', 0.2));
    const staleDays = Number(this.config.get('FORGETTING_STALE_DAYS', 60));

    const candidates = await this.memoryRepo.findForgettingCandidates(threshold, staleDays);
    for (const { user_id, id } of candidates) {
      await this.memoryRepo.deleteKnowledgeMemory(user_id, id);
    }
  }
}
