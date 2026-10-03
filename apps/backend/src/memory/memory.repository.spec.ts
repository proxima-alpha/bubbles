import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { computeScore, MemoryRepository } from './memory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { MessageRepository } from '../message/message.repository';
import { ModelService } from '../model/model.service';

const mockPrisma = {
  memory: {
    findFirst: jest.fn(),
  },
  $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(undefined)),
};

const mockMessageRepo = {
  updateRootMemoryId: jest.fn(),
};

const mockModelService = {
  embedTexts: jest.fn(),
  getAverageCentroid: jest.fn(),
};

const mockConfig = {
  get: jest.fn((_key: string, def: unknown) => def),
};

function createMockTx() {
  return {
    memory__memory_content: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
    memory: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ summary: null, is_pinned: false }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'new-memory-id', root_memory_id: null }),
    },
    memory_content: {
      create: jest.fn().mockResolvedValue({ id: 'new-content-id' }),
    },
    memory_content__message: {
      createMany: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

describe('MemoryRepository', () => {
  let repo: MemoryRepository;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfig.get.mockImplementation((_key: string, def: unknown) => def);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(undefined));

    const module = await Test.createTestingModule({
      providers: [
        MemoryRepository,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: MessageRepository, useValue: mockMessageRepo },
        { provide: ModelService, useValue: mockModelService },
      ],
    }).compile();
    repo = module.get(MemoryRepository);
  });

  describe('computeScore', () => {
    it('repetition_count가 0이면 confirmedScore에 반복 기여도가 0이어야 한다', () => {
      const { confirmedScore } = computeScore({
        importance: 0, durability: 0, reusefulness: 0,
        explicit_signal: 0, repetition_count: 0, llm_confidence_hint: 1,
        sensitivity: 0, last_referenced_at: null, created_at: new Date(),
      }, 30, 10);

      // confirmedScore = 0.5*0 + 0.35*0 + 0.15*1 = 0.15
      expect(confirmedScore).toBeCloseTo(0.15, 5);
    });

    it('반복 횟수가 늘수록 confirmedScore도 늘어나야 한다', () => {
      const base = {
        importance: 0, durability: 0, reusefulness: 0,
        explicit_signal: 1, llm_confidence_hint: 0,
        sensitivity: 0, last_referenced_at: null, created_at: new Date(),
      };
      const low = computeScore({ ...base, repetition_count: 0 }, 30, 10);
      const high = computeScore({ ...base, repetition_count: 5 }, 30, 10);

      expect(high.confirmedScore).toBeGreaterThan(low.confirmedScore);
    });

    it('score는 0~1 범위를 벗어나지 않아야 한다(clamp)', () => {
      const { score } = computeScore({
        importance: 1, durability: 1, reusefulness: 1,
        explicit_signal: 1, repetition_count: 999, llm_confidence_hint: 1,
        sensitivity: 0, last_referenced_at: new Date(), created_at: new Date(),
      }, 30, 10);

      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('saveMemory', () => {
    it('carry + 신규 내용이 이전 버전과 동일하면 새 버전 생성을 스킵해야 한다', async () => {
      const tx = createMockTx();
      tx.memory__memory_content.findMany.mockResolvedValue([
        {
          memory_content_id: 'c1', seq: 0,
          memory_content: { id: 'c1', score: 1, last_referenced_at: new Date(), created_at: new Date() },
        },
      ]);

      const result = await repo.saveMemory(tx as never, 'u1', {
        messageIds: [],
        analysis: { keywords: [], contents: [], summary: '' },
        existingMemory: { id: 'mem1', version: 1, root_memory_id: null },
      });

      expect(result).toEqual({ id: 'mem1', newContentIds: [] });
      expect(tx.memory.create).not.toHaveBeenCalled();
      expect(tx.memory.update).not.toHaveBeenCalled();
    });

    it('forgetting 조건(점수 낮음+오래됨)을 통과 못한 content는 carry에서 제외해야 한다', async () => {
      const tx = createMockTx();
      const stale = new Date(Date.now() - 100 * 86400000); // 100일 전
      tx.memory__memory_content.findMany.mockResolvedValue([
        {
          memory_content_id: 'survivor', seq: 0,
          memory_content: { id: 'survivor', score: 0.9, last_referenced_at: new Date(), created_at: new Date() },
        },
        {
          memory_content_id: 'forgotten', seq: 1,
          memory_content: { id: 'forgotten', score: 0.05, last_referenced_at: stale, created_at: stale },
        },
      ]);

      await repo.saveMemory(tx as never, 'u1', {
        messageIds: [],
        analysis: { keywords: [], contents: [], summary: '' },
        existingMemory: { id: 'mem1', version: 1, root_memory_id: null },
      });

      // 변화가 생겼으니(carried != previous) 새 버전은 생성되고, survivor만 조인돼야 한다
      expect(tx.memory.create).toHaveBeenCalledTimes(1);
      const joinedContentIds = tx.memory__memory_content.create.mock.calls.map(
        (call: unknown[]) => (call[0] as { data: { memory_content_id: string } }).data.memory_content_id,
      );
      expect(joinedContentIds).toEqual(['survivor']);
    });

    it('새 버전에 조인된 content가 0개면 그 새 버전만 비활성 처리해야 한다', async () => {
      const tx = createMockTx();
      const stale = new Date(Date.now() - 100 * 86400000);
      tx.memory__memory_content.findMany.mockResolvedValue([
        {
          memory_content_id: 'forgotten', seq: 0,
          memory_content: { id: 'forgotten', score: 0.05, last_referenced_at: stale, created_at: stale },
        },
      ]);

      await repo.saveMemory(tx as never, 'u1', {
        messageIds: [],
        analysis: { keywords: [], contents: [], summary: '' },
        existingMemory: { id: 'mem1', version: 1, root_memory_id: null },
      });

      expect(tx.memory.update).toHaveBeenCalledWith({
        where: { id: 'new-memory-id' },
        data: { is_active: false, deactivated_at: expect.any(Date) },
      });
    });

    it('근거 메시지가 없는 신규 문장은 저장하지 않아야 한다', async () => {
      const tx = createMockTx();
      mockModelService.embedTexts.mockResolvedValue([[0.1, 0.2]]);

      await repo.saveMemory(tx as never, 'u1', {
        messageIds: ['m1'],
        analysis: {
          keywords: [],
          contents: [
            { text: '근거 없는 문장', importance: 1, durability: 1, reusefulness: 1, sensitivity: 0, explicit_signal: 1, llm_confidence_hint: 1 },
          ],
          associations: [[]], // evidence 없음
          summary: 's',
        },
        existingMemory: null,
      });

      expect(tx.memory_content.create).not.toHaveBeenCalled();
    });
  });

  describe('updateKnowledgeMemory', () => {
    it('id가 있고 텍스트가 기존과 동일하면 기존 row를 재사용해야 한다(in-place UPDATE 없음)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ id: 'mem1', version: 1, root_memory_id: null, is_pinned: false });
      const tx = createMockTx();
      tx.memory__memory_content.findMany.mockResolvedValue([
        { memory_content_id: 'c1', memory_content: { id: 'c1', content: '안 바뀐 문장' } },
      ]);
      mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(tx));

      await repo.updateKnowledgeMemory('u1', 'mem1', [{ id: 'c1', text: '안 바뀐 문장' }], 'summary');

      expect(tx.memory_content.create).not.toHaveBeenCalled();
      expect(tx.memory__memory_content.create).toHaveBeenCalledWith({
        data: { memory_id: 'new-memory-id', memory_content_id: 'c1', seq: 0 },
      });
    });

    it('id가 있어도 텍스트가 바뀌면 새 row를 생성해야 한다(과거 row는 그대로 둠)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ id: 'mem1', version: 1, root_memory_id: null, is_pinned: false });
      const tx = createMockTx();
      tx.memory__memory_content.findMany.mockResolvedValue([
        { memory_content_id: 'c1', memory_content: { id: 'c1', content: '원래 문장' } },
      ]);
      mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(tx));
      mockModelService.embedTexts.mockResolvedValue([[0.1, 0.2]]);

      await repo.updateKnowledgeMemory('u1', 'mem1', [{ id: 'c1', text: '수정된 문장' }], 'summary');

      expect(tx.memory_content.create).toHaveBeenCalledTimes(1);
      expect((tx.memory_content.create as jest.Mock).mock.calls[0][0].data.content).toBe('수정된 문장');
    });
  });
});
