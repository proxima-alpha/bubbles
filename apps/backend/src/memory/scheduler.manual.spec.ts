/**
 * 수동 실행용 테스트 — 실제 DB/LLM에 연결해서 executeMemorization를 직접 실행한다.
 * target_ids에 테스트할 user_id를 넣고 아래 명령으로 실행:
 *   npx dotenv -e .env -- jest scheduler.manual --runInBand
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import { MemoryRepository } from './memory.repository';
import { ChatModule } from '../chat/chat.module';
import { ChatService } from '../chat/chat.service';
import { ChatRepository } from '../chat/chat.repository';
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
    'executeMemorization for user %s',
    async (userId) => {
      if (userId === '__skip__') {
        console.log('target_ids가 비어있습니다. user_id를 넣고 다시 실행하세요.');
        return;
      }
      const results = await service.executeMemorization(userId);
      console.log(`[${userId}] processed ${results.length} memories`, results);
      await service.updateMainMemory(userId, results);
    },
  );
});

describe('ChatService.generateMessageContents (manual)', () => {
  let chatService: ChatService;
  let chatRepo: ChatRepository;

  jest.setTimeout(0);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        ModelModule,
        ChatModule,
      ],
    }).compile();

    chatService = module.get(ChatService);
    chatRepo = module.get(ChatRepository);
  });

  it('message_content가 없는 assistant 메시지를 다시 생성한다', async () => {
    const messages = await chatRepo.findAssistantMessagesWithoutContent();
    if (messages.length === 0) {
      console.log('message_content가 없는 메시지가 없습니다.');
      return;
    }

    for (const message of messages) {
      await chatService.generateMessageContents(
        message.user_id,
        message.parent_message!.content,
        message.content,
        message.id,
      );
      console.log(`[${message.id}] message_content regenerated`);
    }
  });
});
