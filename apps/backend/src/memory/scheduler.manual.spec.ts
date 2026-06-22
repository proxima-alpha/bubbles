/**
 * 수동 실행용 테스트 — 실제 DB/LLM에 연결해서 runBatch를 직접 실행한다.
 * target_ids에 테스트할 user_id를 넣고 아래 명령으로 실행:
 *   npx dotenv -e .env -- jest scheduler.manual --runInBand
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import { MemoryRepository } from './memory.repository';
import { ModelModule } from '../model/model.module';
import { PrismaModule } from '../prisma/prisma.module';

const target_ids: string[] = ['c4425f73-5f1c-4d24-8f92-fd074d88167e'];

describe('SchedulerService (manual)', () => {
  let service: SchedulerService;

  jest.setTimeout(0);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        ModelModule,
      ],
      providers: [MemoryRepository, SchedulerService],
    }).compile();

    service = module.get(SchedulerService);
  });

  it.each(target_ids.length ? target_ids : ['__skip__'])(
    'runBatch for user %s',
    async (userId) => {
      if (userId === '__skip__') {
        console.log('target_ids가 비어있습니다. user_id를 넣고 다시 실행하세요.');
        return;
      }
      const results = await service.runBatch(userId);
      console.log(`[${userId}] processed ${results.length} memories`, results);
      await service.updateMainMemory(userId, results);
    },
  );
});
