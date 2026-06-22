import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemoryRepository } from './memory.repository';

@Injectable()
export class DecayScheduler {
  constructor(private memoryRepo: MemoryRepository) {}

  @Cron('0 0 * * *')
  async applyDecay() {
    await this.memoryRepo.applyDecay();
  }
}
