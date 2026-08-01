import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { ModelModule } from '../model/model.module';
import { MemoryService } from './memory.service';
import { MemoryController } from './memory.controller';
import { SchedulerService } from './scheduler.service';
import { DecayScheduler } from './decay.scheduler';
import { ForgettingScheduler } from './forgetting.scheduler';
import { MemoryRepository } from './memory.repository';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, ModelModule],
  providers: [MemoryService, MemoryRepository, SchedulerService, DecayScheduler, ForgettingScheduler],
  controllers: [MemoryController],
  exports: [MemoryService],
})
export class MemoryModule {}
