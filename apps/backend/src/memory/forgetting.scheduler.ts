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

  // memorize 스케줄러(checkAndRun)와 동시 실행 금지 대상(feed-002.md 7번) — memorize 배치가 아직
  // cron에 연결되지 않은 상태(scheduler.service.ts:44-55 주석 처리)라 현재는 실질적 레이스 없음.
  // memorize 스케줄링이 실제로 켜지면 순서 보장 방법을 다시 결정해야 함(todo.md 기록).
  @Cron('0 1 * * *') // decay 이후 시각대(00:00 UTC decay, 01:00 UTC forgetting)
  async applyForgetting() {
    // config.get<boolean>()도 number와 같은 문제 — env string "false"가 truthy라 !enabled가 항상 false가 됨
    if (this.config.get('FORGETTING_ENABLED', 'false') !== 'true') return;
    const threshold = Number(this.config.get('FORGETTING_SCORE_THRESHOLD', 0.2));
    const staleDays = Number(this.config.get('FORGETTING_STALE_DAYS', 60));

    const candidates = await this.memoryRepo.findForgettingCandidates(threshold, staleDays);
    for (const { user_id, id } of candidates) {
      await this.memoryRepo.applyForgettingToMemory(user_id, id);
    }
  }
}
